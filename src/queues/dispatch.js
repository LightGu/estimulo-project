const { createQueue, createQueueEvents, createWorker } = require("./bullmq");
const { queueNames } = require("./names");
const { buildJitteredDispatchSchedule } = require("./dispatch-jitter");
const { sendToEvolution } = require("../services/evolution");
const { downloadFromDrive } = require("../services/google-drive-video-download");
const defaultDispatchConsistencyService = require("../services/dispatch-consistency.service");
const defaultVideoCaptionsService = require("../services/video-captions.service");
const groupVideoProgressRepository = require("../repositories/group-video-progress.repository");

const DISPATCH_JOB_NAME = "dispatch-content";
const DISPATCH_INITIAL_STATUS = "pending";
const DISPATCH_PROCESSING_STATUS = "processing";
const DISPATCH_SUCCESS_STATUS = "sent";
const DISPATCH_FAILED_STATUS = "failed";
const DEFAULT_DISPATCH_JOB_TIMEOUT_MS = 25 * 60 * 1000;

let dispatchQueueInstance;

function resolveDispatchJobTimeoutMs() {
  const timeoutMs = Number(process.env.DISPATCH_JOB_TIMEOUT_MS || DEFAULT_DISPATCH_JOB_TIMEOUT_MS);

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_DISPATCH_JOB_TIMEOUT_MS;
  }

  return Math.trunc(timeoutMs);
}

function getDispatchQueue() {
  if (!dispatchQueueInstance) {
    dispatchQueueInstance = createQueue(queueNames.dispatch, {
      defaultJobOptions: {
        attempts: 1,
        timeout: resolveDispatchJobTimeoutMs(),
      },
    });
  }

  return dispatchQueueInstance;
}

function normalizeScheduledDate(scheduledAt = new Date()) {
  const date = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);

  if (Number.isNaN(date.getTime())) {
    throw new Error("scheduled_at deve ser uma data valida");
  }

  return date;
}

function assertRequiredField(params, fieldName) {
  if (!params || params[fieldName] === undefined || params[fieldName] === null || params[fieldName] === "") {
    throw new Error(`${fieldName} e obrigatorio para enfileirar dispatch`);
  }
}

function buildDispatchJobData(params) {
  if (params && params.envia_video === false) {
    throw new Error("grupo com envia_video=false nao pode ser enfileirado para dispatch de video");
  }

  assertRequiredField(params, "group_id");
  assertRequiredField(params, "campaign_id");

  if (!params.link_video && !params.video_id && !params.drive_file_id && !params.video_catalog) {
    throw new Error("link_video, video_id ou drive_file_id e obrigatorio para enfileirar dispatch");
  }

  const scheduledDate = normalizeScheduledDate(params.scheduled_at || params.scheduledAt);

  return {
    group_id: params.group_id,
    progress_group_id: params.progress_group_id || params.progressGroupId || (params.group && params.group.id),
    campaign_id: params.campaign_id,
    link_video: params.link_video,
    video_id: params.video_id || (params.video_catalog && params.video_catalog.id),
    drive_file_id: params.drive_file_id || (params.video_catalog && params.video_catalog.drive_file_id),
    video_catalog: params.video_catalog,
    legenda: params.legenda || "",
    scheduled_at: scheduledDate.toISOString(),
    status: params.status || DISPATCH_INITIAL_STATUS,
    dispatch_order: params.dispatch_order,
    jitter_delay_ms: params.jitter_delay_ms,
    cumulative_delay_ms: params.cumulative_delay_ms,
  };
}

function buildDispatchJobOptions(jobData, options = {}) {
  const scheduledTime = new Date(jobData.scheduled_at).getTime();
  const delay = Math.max(scheduledTime - Date.now(), 0);

  return {
    ...options,
    delay: options.delay ?? delay,
  };
}

function assertDownloadedVideoForDispatch(downloadedVideo) {
  if (!downloadedVideo || !Buffer.isBuffer(downloadedVideo.bytes)) {
    throw new Error("Download do Google Drive nao retornou bytes de video validos");
  }

  if (downloadedVideo.bytes.length === 0) {
    throw new Error("Download do Google Drive retornou video vazio");
  }

  if (!downloadedVideo.mime_type || !downloadedVideo.mime_type.toLowerCase().startsWith("video/")) {
    throw new Error(`Tipo MIME invalido para envio de video: ${downloadedVideo.mime_type || "indefinido"}`);
  }
}

function buildDispatchDeliveryPayload(jobData, downloadedVideo) {
  if (downloadedVideo) {
    assertDownloadedVideoForDispatch(downloadedVideo);

    return {
      groupId: jobData.group_id,
      message: jobData.legenda || "",
      content: {
        base64: downloadedVideo.bytes.toString("base64"),
        fileName: downloadedVideo.name,
        mimeType: downloadedVideo.mime_type,
        type: "video",
      },
    };
  }

  return {
    groupId: jobData.group_id,
    message: jobData.legenda || "",
    content: {
      url: jobData.link_video,
      fileName: "campaign-video.mp4",
      mimeType: "video/mp4",
      type: "video",
    },
  };
}

async function resolveDispatchCaption(jobData, captionSelector, logger = console, options = {}) {
  const fallbackCaption = jobData.legenda || "";

  if (!jobData.video_id || !captionSelector || typeof captionSelector.selectCaptionForVideo !== "function") {
    return fallbackCaption;
  }

  let selected;

  try {
    selected = await captionSelector.selectCaptionForVideo(jobData.video_id, options);
  } catch (error) {
    logger.warn &&
      logger.warn(
        JSON.stringify({
          event: "dispatch.caption.selection_failed",
          campaign_id: jobData.campaign_id,
          group_id: jobData.group_id,
          progress_group_id: jobData.progress_group_id,
          video_id: jobData.video_id,
          error_message: error.message,
        })
      );

    return fallbackCaption;
  }

  if (!selected || !selected.text) {
    return fallbackCaption;
  }

  logger.info &&
    logger.info(
      JSON.stringify({
        event: "dispatch.caption.selected",
        campaign_id: jobData.campaign_id,
        group_id: jobData.group_id,
        progress_group_id: jobData.progress_group_id,
        video_id: jobData.video_id,
        caption_id: selected.caption && selected.caption.id,
        generated: Boolean(selected.generated),
      })
    );

  return selected.text;
}

function releaseTemporaryDispatchMedia(downloadedVideo, deliveryPayload) {
  if (downloadedVideo) {
    downloadedVideo.bytes = undefined;
  }

  if (deliveryPayload && deliveryPayload.content) {
    deliveryPayload.content.base64 = undefined;
  }
}

function canUseDispatchConsistency(jobData = {}, dispatchConsistencyService) {
  return Boolean(
    dispatchConsistencyService &&
      typeof dispatchConsistencyService.executeDispatch === "function" &&
      jobData.campaign_id &&
      jobData.progress_group_id &&
      jobData.video_id
  );
}

function createDeliveryExecutor(params = {}) {
  const {
    drive,
    jobData,
    logger = console,
    sender,
    videoCatalogRepository,
    videoCaptionsService,
    videoDownloader,
  } = params;
  const shouldDownloadVideo = Boolean(
    jobData.drive_file_id ||
      (jobData.video_catalog && (jobData.video_catalog.drive_file_id || jobData.video_catalog.driveFileId)) ||
      (jobData.video_id && !jobData.link_video)
  );

  return async function executeDelivery() {
    let downloadedVideo;
    let deliveryPayload;

    try {
      if (shouldDownloadVideo) {
        logger.info &&
          logger.info(
            JSON.stringify({
              event: "dispatch.video_download.started",
              campaign_id: jobData.campaign_id,
              group_id: jobData.group_id,
              progress_group_id: jobData.progress_group_id,
              video_id: jobData.video_id,
              drive_file_id: jobData.drive_file_id,
            })
          );

        downloadedVideo = await videoDownloader({
          drive,
          videoCatalogRepository,
          videoCatalogRecord: jobData.video_catalog,
          videoId: jobData.video_id,
          driveFileId: jobData.drive_file_id,
        });

        logger.info &&
          logger.info(
            JSON.stringify({
              event: "dispatch.video_download.completed",
              campaign_id: jobData.campaign_id,
              group_id: jobData.group_id,
              progress_group_id: jobData.progress_group_id,
              video_id: jobData.video_id,
              drive_file_id: jobData.drive_file_id,
              bytes: downloadedVideo && downloadedVideo.bytes && downloadedVideo.bytes.length,
              mime_type: downloadedVideo && downloadedVideo.mime_type,
            })
          );
      }

      const caption = await resolveDispatchCaption(jobData, videoCaptionsService, logger, { downloadedVideo });
      deliveryPayload = buildDispatchDeliveryPayload({ ...jobData, legenda: caption }, downloadedVideo);
      logger.info &&
        logger.info(
          JSON.stringify({
            event: "dispatch.provider_send.started",
            campaign_id: jobData.campaign_id,
            group_id: jobData.group_id,
            progress_group_id: jobData.progress_group_id,
            video_id: jobData.video_id,
          })
        );
      const result = await sender(deliveryPayload);
      logger.info &&
        logger.info(
          JSON.stringify({
            event: "dispatch.provider_send.completed",
            campaign_id: jobData.campaign_id,
            group_id: jobData.group_id,
            progress_group_id: jobData.progress_group_id,
            video_id: jobData.video_id,
            status: result && result.status,
            success: result && result.data && result.data.success,
          })
        );

      return result;
    } finally {
      releaseTemporaryDispatchMedia(downloadedVideo, deliveryPayload);
    }
  };
}

async function addDispatchJob(params, options = {}) {
  const jobData = buildDispatchJobData(params);
  const jobOptions = buildDispatchJobOptions(jobData, options);

  return getDispatchQueue().add(DISPATCH_JOB_NAME, jobData, jobOptions);
}

async function addJitteredDispatchJobs(params, options = {}) {
  const schedule = buildJitteredDispatchSchedule(params);
  const jobs = [];

  for (const jobData of schedule) {
    jobs.push(await addDispatchJob(jobData, options));
  }

  return jobs;
}

async function registerDispatchProgress(jobData, repository = groupVideoProgressRepository) {
  const groupId = jobData.progress_group_id;
  const videoId = jobData.video_id;

  if (!groupId || !videoId) {
    return null;
  }

  const duplicate = await repository.hasDuplicate(groupId, videoId);

  if (duplicate) {
    return {
      duplicate: true,
      record: null,
    };
  }

  const record = await repository.registerDelivery({
    group_id: groupId,
    video_id: videoId,
  });

  return {
    duplicate: false,
    record,
  };
}

function createDispatchProcessor(options = {}) {
  const {
    sender = sendToEvolution,
    videoDownloader = downloadFromDrive,
    drive,
    videoCatalogRepository,
    progressRepository = groupVideoProgressRepository,
    dispatchConsistencyService,
    videoCaptionsService,
    logger = console,
  } = options;

  return async function dispatchWorker(job) {
    const startedAt = new Date().toISOString();

    await job.updateData({
      ...job.data,
      status: DISPATCH_PROCESSING_STATUS,
      started_at: startedAt,
    });

    try {
      console.info(
        JSON.stringify({
          event: "dispatch.started",
          job_id: job.id,
          campaign_id: job.data.campaign_id,
          group_id: job.data.group_id,
          progress_group_id: job.data.progress_group_id,
          video_id: job.data.video_id,
          drive_file_id: job.data.drive_file_id,
          started_at: startedAt,
        })
      );

      const executeDelivery = createDeliveryExecutor({
        drive,
        jobData: job.data,
        logger,
        sender,
        videoCatalogRepository,
        videoCaptionsService,
        videoDownloader,
      });
      const useDispatchConsistency = canUseDispatchConsistency(job.data, dispatchConsistencyService);
      let delivery;
      let progress;

      if (useDispatchConsistency) {
        const result = await dispatchConsistencyService.executeDispatch({
          campaignId: job.data.campaign_id,
          groupId: job.data.progress_group_id,
          videoId: job.data.video_id,
          sender: executeDelivery,
        });

        delivery = result.result;
        progress = result.progress;
      } else {
        delivery = await executeDelivery();
        progress = await registerDispatchProgress(job.data, progressRepository);
      }

      const completedAt = new Date().toISOString();

      await job.updateData({
        ...job.data,
        status: DISPATCH_SUCCESS_STATUS,
        started_at: startedAt,
        completed_at: completedAt,
        progress_registered: Boolean(progress && !progress.duplicate),
        progress_duplicate: Boolean(progress && progress.duplicate),
      });

      console.info(
        JSON.stringify({
          event: "dispatch.sent",
          job_id: job.id,
          campaign_id: job.data.campaign_id,
          group_id: job.data.group_id,
          progress_group_id: job.data.progress_group_id,
          video_id: job.data.video_id,
          progress_registered: Boolean(progress && !progress.duplicate),
          progress_duplicate: Boolean(progress && progress.duplicate),
          started_at: startedAt,
          completed_at: completedAt,
        })
      );

      return {
        status: DISPATCH_SUCCESS_STATUS,
        delivery,
        progress,
        started_at: startedAt,
        completed_at: completedAt,
      };
    } catch (error) {
      const failedAt = new Date().toISOString();

      await job.updateData({
        ...job.data,
        status: DISPATCH_FAILED_STATUS,
        started_at: startedAt,
        failed_at: failedAt,
        error_message: error.message,
      });

      console.error(
        JSON.stringify({
          event: "dispatch.failed",
          job_id: job.id,
          campaign_id: job.data.campaign_id,
          group_id: job.data.group_id,
          started_at: startedAt,
          failed_at: failedAt,
          error_message: error.message,
        })
      );

      throw error;
    }
  };
}

const dispatchWorker = createDispatchProcessor({
  dispatchConsistencyService: defaultDispatchConsistencyService,
  videoCaptionsService: defaultVideoCaptionsService,
});

function createDispatchWorker(options = {}) {
  const {
    sender = sendToEvolution,
    videoDownloader = downloadFromDrive,
    drive,
    videoCatalogRepository,
    progressRepository = groupVideoProgressRepository,
    dispatchConsistencyService = defaultDispatchConsistencyService,
    videoCaptionsService = defaultVideoCaptionsService,
    logger = console,
    ...workerOptions
  } = options;

  return createWorker(
    queueNames.dispatch,
    createDispatchProcessor({
      sender,
      videoDownloader,
      drive,
      videoCatalogRepository,
      progressRepository,
      dispatchConsistencyService,
      videoCaptionsService,
      logger,
    }),
    workerOptions
  );
}

function createDispatchEvents(options = {}) {
  return createQueueEvents(queueNames.dispatch, options);
}

module.exports = {
  DISPATCH_FAILED_STATUS,
  DISPATCH_INITIAL_STATUS,
  DISPATCH_JOB_NAME,
  DISPATCH_PROCESSING_STATUS,
  DISPATCH_SUCCESS_STATUS,
  addDispatchJob,
  addJitteredDispatchJobs,
  assertDownloadedVideoForDispatch,
  buildDispatchDeliveryPayload,
  buildDispatchJobData,
  buildJitteredDispatchSchedule,
  createDispatchProcessor,
  createDispatchEvents,
  createDispatchWorker,
  dispatchWorker,
  registerDispatchProgress,
  resolveDispatchCaption,
  get dispatchQueue() {
    return getDispatchQueue();
  },
};
