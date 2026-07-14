const { createQueue, createQueueEvents, createWorker } = require("./bullmq");
const { queueNames } = require("./names");
const { buildJitteredDispatchSchedule } = require("./dispatch-jitter");
const { sendToEvolution } = require("../services/evolution");
const { downloadFromDrive } = require("../services/google-drive-video-download");

const DISPATCH_JOB_NAME = "dispatch-content";
const DISPATCH_INITIAL_STATUS = "pending";
const DISPATCH_PROCESSING_STATUS = "processing";
const DISPATCH_SUCCESS_STATUS = "sent";
const DISPATCH_FAILED_STATUS = "failed";

let dispatchQueueInstance;

function getDispatchQueue() {
  if (!dispatchQueueInstance) {
    dispatchQueueInstance = createQueue(queueNames.dispatch, {
      defaultJobOptions: {
        attempts: 1,
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
  assertRequiredField(params, "group_id");
  assertRequiredField(params, "campaign_id");
  assertRequiredField(params, "legenda");

  if (!params.link_video && !params.video_id && !params.drive_file_id && !params.video_catalog) {
    throw new Error("link_video, video_id ou drive_file_id e obrigatorio para enfileirar dispatch");
  }

  const scheduledDate = normalizeScheduledDate(params.scheduled_at || params.scheduledAt);

  return {
    group_id: params.group_id,
    campaign_id: params.campaign_id,
    link_video: params.link_video,
    video_id: params.video_id || (params.video_catalog && params.video_catalog.id),
    drive_file_id: params.drive_file_id || (params.video_catalog && params.video_catalog.drive_file_id),
    video_catalog: params.video_catalog,
    legenda: params.legenda,
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
      message: jobData.legenda,
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
    message: jobData.legenda,
    content: {
      url: jobData.link_video,
      fileName: "campaign-video.mp4",
      mimeType: "video/mp4",
      type: "video",
    },
  };
}

function releaseTemporaryDispatchMedia(downloadedVideo, deliveryPayload) {
  if (downloadedVideo) {
    downloadedVideo.bytes = undefined;
  }

  if (deliveryPayload && deliveryPayload.content) {
    deliveryPayload.content.base64 = undefined;
  }
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

function createDispatchProcessor(options = {}) {
  const {
    sender = sendToEvolution,
    videoDownloader = downloadFromDrive,
    drive,
    videoCatalogRepository,
  } = options;

  return async function dispatchWorker(job) {
    const startedAt = new Date().toISOString();

    await job.updateData({
      ...job.data,
      status: DISPATCH_PROCESSING_STATUS,
      started_at: startedAt,
    });

    try {
      const shouldDownloadVideo = Boolean(job.data.video_catalog || job.data.video_id || job.data.drive_file_id);
      let downloadedVideo;
      let deliveryPayload;

      try {
        downloadedVideo = shouldDownloadVideo
          ? await videoDownloader({
            drive,
            videoCatalogRepository,
            videoCatalogRecord: job.data.video_catalog,
            videoId: job.data.video_id,
            driveFileId: job.data.drive_file_id,
          })
          : undefined;
        deliveryPayload = buildDispatchDeliveryPayload(job.data, downloadedVideo);
        const delivery = await sender(deliveryPayload);
        releaseTemporaryDispatchMedia(downloadedVideo, deliveryPayload);
        deliveryPayload = undefined;
        downloadedVideo = undefined;
        const completedAt = new Date().toISOString();

        await job.updateData({
          ...job.data,
          status: DISPATCH_SUCCESS_STATUS,
          started_at: startedAt,
          completed_at: completedAt,
        });

        console.info(
          JSON.stringify({
            event: "dispatch.sent",
            job_id: job.id,
            campaign_id: job.data.campaign_id,
            group_id: job.data.group_id,
            started_at: startedAt,
            completed_at: completedAt,
          })
        );

        return {
          status: DISPATCH_SUCCESS_STATUS,
          delivery,
          started_at: startedAt,
          completed_at: completedAt,
        };
      } finally {
        releaseTemporaryDispatchMedia(downloadedVideo, deliveryPayload);
      }
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

const dispatchWorker = createDispatchProcessor();

function createDispatchWorker(options = {}) {
  const {
    sender = sendToEvolution,
    videoDownloader = downloadFromDrive,
    drive,
    videoCatalogRepository,
    ...workerOptions
  } = options;

  return createWorker(
    queueNames.dispatch,
    createDispatchProcessor({ sender, videoDownloader, drive, videoCatalogRepository }),
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
  get dispatchQueue() {
    return getDispatchQueue();
  },
};
