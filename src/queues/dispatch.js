const { createQueue, createQueueEvents, createWorker } = require("./bullmq");
const { queueNames } = require("./names");
const { buildJitteredDispatchSchedule } = require("./dispatch-jitter");
const { EvolutionDeliveryProvider, sendToEvolution } = require("../services/evolution");
const { evolutionConfig } = require("../config/evolution");
const { downloadFromDrive } = require("../services/google-drive-video-download");
const defaultCaptionReviewService = require("../services/caption-review.service");
const defaultDispatchConsistencyService = require("../services/dispatch-consistency.service");
const defaultVideoCaptionsService = require("../services/video-captions.service");
const groupVideoProgressRepository = require("../repositories/group-video-progress.repository");
const defaultVideoCatalogRepository = require("../repositories/video-catalog.repository");
const defaultGroupsRepository = require("../repositories/groups.repository");
const defaultWhatsappInstancesRepository = require("../repositories/whatsapp-instances.repository");
const defaultCampaignsRepository = require("../repositories/campaigns.repository");
const defaultCampaignGroupsRepository = require("../repositories/campaign-groups.repository");
const defaultNotificationsService = require("../services/notifications.service");

const DISPATCH_JOB_NAME = "dispatch-content";
const DISPATCH_INITIAL_STATUS = "pending";
const DISPATCH_PROCESSING_STATUS = "processing";
const DISPATCH_SUCCESS_STATUS = "sent";
const DISPATCH_FAILED_STATUS = "failed";
const DEFAULT_DISPATCH_JOB_TIMEOUT_MS = 25 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    trilha_id: params.trilha_id || params.trilhaId,
    video_id: params.video_id || (params.video_catalog && params.video_catalog.id),
    drive_file_id: params.drive_file_id || (params.video_catalog && params.video_catalog.drive_file_id),
    video_catalog: params.video_catalog,
    legenda: params.legenda || "",
    caption_id: params.caption_id || params.captionId,
    caption_generated: params.caption_generated ?? params.captionGenerated,
    scheduled_at: scheduledDate.toISOString(),
    status: params.status || DISPATCH_INITIAL_STATUS,
    dispatch_order: params.dispatch_order,
    jitter_delay_ms: params.jitter_delay_ms,
    cumulative_delay_ms: params.cumulative_delay_ms,
    whatsapp_instance_id: params.whatsapp_instance_id,
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

  // caption_generated=true indica que a legenda ja foi gerada/revisada na Etapa 2
  // (tela envio-automatizado, tabela campaign_video_captions) e o usuario ja viu
  // esse texto especifico. Nesse caso ela e definitiva e nao deve ser trocada por
  // outra no dispatch — mesmo quando caption_id vem nulo (legenda de teste inserida
  // manualmente, ou linha sem video_captions.id associado). Sem essa checagem por
  // caption_generated, o dispatch chamava a IA de novo para "sortear" uma legenda
  // diferente, gerando texto novo e consumindo cota desnecessariamente.
  if ((jobData.caption_id || jobData.caption_generated) && fallbackCaption) {
    return {
      caption: jobData.caption_id ? { id: jobData.caption_id } : null,
      generated: Boolean(jobData.caption_generated),
      text: fallbackCaption,
    };
  }

  if (!jobData.video_id || !captionSelector || typeof captionSelector.selectCaptionForVideo !== "function") {
    return {
      caption: null,
      generated: false,
      text: fallbackCaption,
    };
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

    if (options.failOnCaptionError) {
      throw error;
    }

    return {
      caption: null,
      generated: false,
      text: fallbackCaption,
    };
  }

  if (!selected || !selected.text) {
    return {
      caption: null,
      generated: false,
      text: fallbackCaption,
    };
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

  return selected;
}

async function resolveVideoTranscript(jobData, videoCatalogRepository = defaultVideoCatalogRepository) {
  const catalogTranscript = jobData.video_catalog && (jobData.video_catalog.transcript || jobData.video_catalog.transcricao);

  if (catalogTranscript) {
    return String(catalogTranscript).trim();
  }

  if (!jobData.video_id || !videoCatalogRepository || typeof videoCatalogRepository.findById !== "function") {
    return "";
  }

  const video = await videoCatalogRepository.findById(jobData.video_id);

  return String((video && (video.transcript || video.transcricao)) || "").trim();
}

async function prepareDispatchCaptionBeforeQueue(jobData, dependencies = {}) {
  const {
    captionReviewService = defaultCaptionReviewService,
    logger = console,
    videoCaptionsService = defaultVideoCaptionsService,
    videoCatalogRepository = defaultVideoCatalogRepository,
  } = dependencies;
  const transcript = await resolveVideoTranscript(jobData, videoCatalogRepository);

  if (!jobData.video_id) {
    return {
      caption: null,
      generated: false,
      text: jobData.legenda || "",
    };
  }

  if (!jobData.video_id || !videoCaptionsService || typeof videoCaptionsService.selectCaptionForVideo !== "function") {
    if (captionReviewService && typeof captionReviewService.assertCaptionApproved === "function") {
      await captionReviewService.assertCaptionApproved({
        caption: jobData.legenda,
        transcript,
        campaign_id: jobData.campaign_id,
        group_id: jobData.group_id,
        progress_group_id: jobData.progress_group_id,
        video_id: jobData.video_id,
      });
    }

    return {
      caption: jobData.caption_id ? { id: jobData.caption_id } : null,
      generated: Boolean(jobData.caption_generated),
      text: jobData.legenda || "",
    };
  }

  const selected = await videoCaptionsService.selectCaptionForVideo(jobData.video_id, {
    transcript,
    requireCaptionReview: true,
    campaign_id: jobData.campaign_id,
    group_id: jobData.group_id,
    progress_group_id: jobData.progress_group_id,
  });

  if (selected && selected.text) {
    logger.info &&
      logger.info(
        JSON.stringify({
          event: "dispatch.caption.prepared",
          campaign_id: jobData.campaign_id,
          group_id: jobData.group_id,
          progress_group_id: jobData.progress_group_id,
          video_id: jobData.video_id,
          caption_id: selected.caption && selected.caption.id,
          generated: Boolean(selected.generated),
        })
      );

    return selected;
  }

  if (captionReviewService && typeof captionReviewService.assertCaptionApproved === "function") {
    await captionReviewService.assertCaptionApproved({
      caption: jobData.legenda,
      transcript,
      campaign_id: jobData.campaign_id,
      group_id: jobData.group_id,
      progress_group_id: jobData.progress_group_id,
      video_id: jobData.video_id,
    });
  }

  return {
    caption: jobData.caption_id ? { id: jobData.caption_id } : null,
    generated: Boolean(jobData.caption_generated),
    text: jobData.legenda || "",
  };
}

async function markDispatchCaptionUsed(params = {}) {
  const { captionSelection, jobData, logger = console, usedAt = new Date(), videoCaptionsService } = params;
  const captionId = captionSelection?.caption?.id || jobData?.caption_id;

  if (!captionId || !videoCaptionsService || typeof videoCaptionsService.markCaptionUsed !== "function") {
    return null;
  }

  const marked = await videoCaptionsService.markCaptionUsed(captionId, { usedAt });

  logger.info &&
    logger.info(
      JSON.stringify({
        event: "dispatch.caption.marked_used",
        campaign_id: jobData && jobData.campaign_id,
        group_id: jobData && jobData.group_id,
        progress_group_id: jobData && jobData.progress_group_id,
        video_id: jobData && jobData.video_id,
        caption_id: captionId,
        used_at: usedAt.toISOString(),
      })
    );

  return marked;
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
      UUID_PATTERN.test(String(jobData.campaign_id || "")) &&
      UUID_PATTERN.test(String(jobData.progress_group_id || "")) &&
      UUID_PATTERN.test(String(jobData.video_id || ""))
  );
}

// Resolve o sender a ser usado no envio deste job: sem whatsapp_instance_id
// (instalacoes com um unico numero, ou compatibilidade retroativa), usa o
// sender global padrao; com um id valido, monta um EvolutionDeliveryProvider
// apontando para a instancia especifica. Se a instancia nao existir mais,
// falha aberto para o sender padrao em vez de derrubar o job em andamento.
async function resolveDispatchSender(whatsappInstanceId, options = {}) {
  const repository = options.whatsappInstancesRepository || defaultWhatsappInstancesRepository;

  if (!whatsappInstanceId) {
    return sendToEvolution;
  }

  const instance = await repository.findById(whatsappInstanceId);

  if (!instance) {
    return sendToEvolution;
  }

  const provider = new EvolutionDeliveryProvider({
    config: { ...evolutionConfig, instanceName: instance.instance_name },
  });

  return (params) => provider.send(params);
}

function createDeliveryExecutor(params = {}) {
  const {
    drive,
    jobData,
    logger = console,
    sender,
    captionReviewService,
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
      const downloadPromise = shouldDownloadVideo
        ? (async () => {
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

            const video = await videoDownloader({
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
                  bytes: video && video.bytes && video.bytes.length,
                  mime_type: video && video.mime_type,
                })
              );

            return video;
          })()
        : Promise.resolve(null);
      const transcriptPromise =
        jobData.video_id && captionReviewService
          ? resolveVideoTranscript(jobData, videoCatalogRepository)
          : Promise.resolve(undefined);
      const captionPromise = (async () => {
        return resolveDispatchCaption(jobData, videoCaptionsService, logger, {
          downloadedVideo: shouldDownloadVideo ? downloadPromise : undefined,
          transcript: transcriptPromise,
          requireCaptionReview: Boolean(jobData.video_id && captionReviewService),
          failOnCaptionError: Boolean(jobData.video_id && videoCaptionsService && !jobData.legenda),
          campaign_id: jobData.campaign_id,
          group_id: jobData.group_id,
          progress_group_id: jobData.progress_group_id,
        });
      })();
      const [downloadedVideoResult, captionSelection] = await Promise.all([downloadPromise, captionPromise]);
      const transcript = await transcriptPromise;

      downloadedVideo = downloadedVideoResult;

      if (jobData.video_id && captionReviewService && typeof captionReviewService.assertCaptionApproved === "function") {
        await captionReviewService.assertCaptionApproved({
          caption: captionSelection.text,
          transcript,
          campaign_id: jobData.campaign_id,
          group_id: jobData.group_id,
          progress_group_id: jobData.progress_group_id,
          video_id: jobData.video_id,
        });
      }
      deliveryPayload = buildDispatchDeliveryPayload({ ...jobData, legenda: captionSelection.text }, downloadedVideo);
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
      await markDispatchCaptionUsed({
        captionSelection,
        jobData,
        logger,
        usedAt: new Date(),
        videoCaptionsService,
      });

      return result;
    } finally {
      releaseTemporaryDispatchMedia(downloadedVideo, deliveryPayload);
    }
  };
}

async function addDispatchJob(params, options = {}) {
  const jobData = buildDispatchJobData(params);
  const { dependencies: _ignoredDependencies, ...jobOptionOverrides } = options;
  const jobOptions = buildDispatchJobOptions(jobData, jobOptionOverrides);

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

async function registerDispatchProgress(
  jobData,
  repository = groupVideoProgressRepository,
  groupsRepository = defaultGroupsRepository
) {
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

  const trilhaId = jobData.trilha_id || jobData.trilhaId || null;

  const record = await repository.registerDelivery({
    group_id: groupId,
    video_id: videoId,
    trilha_id: trilhaId,
  });

  if (trilhaId) {
    await groupsRepository.update(groupId, { trilha_id: trilhaId });
  }

  return {
    duplicate: false,
    record,
  };
}

async function maybeNotifyCampaignFinished(jobData, dependencies = {}) {
  const {
    campaignsRepository = defaultCampaignsRepository,
    campaignGroupsRepository = defaultCampaignGroupsRepository,
    notificationsService = defaultNotificationsService,
    logger = console,
  } = dependencies;

  try {
    const isFinished = await campaignGroupsRepository.isCampaignFullyTerminal(jobData.campaign_id);

    if (!isFinished) {
      return;
    }

    const campaign = await campaignsRepository.findById(jobData.campaign_id);

    await notificationsService.notifyCampaignFinished({
      campaignId: jobData.campaign_id,
      campaignLabel: campaign && campaign.trilha,
    });
  } catch (error) {
    logger.error &&
      logger.error(
        JSON.stringify({
          event: "dispatch.campaign_finished_check_failed",
          campaign_id: jobData.campaign_id,
          error_message: error.message,
        })
      );
  }
}

function createDispatchProcessor(options = {}) {
  const {
    sender: explicitSender,
    videoDownloader = downloadFromDrive,
    drive,
    videoCatalogRepository,
    progressRepository = groupVideoProgressRepository,
    groupsRepository = defaultGroupsRepository,
    whatsappInstancesRepository,
    dispatchConsistencyService,
    captionReviewService,
    videoCaptionsService,
    campaignsRepository = defaultCampaignsRepository,
    campaignGroupsRepository = defaultCampaignGroupsRepository,
    notificationsService = defaultNotificationsService,
    logger = console,
  } = options;

  return async function dispatchWorker(job) {
    const startedAt = new Date().toISOString();

    try {
      await job.updateData({
        ...job.data,
        status: DISPATCH_PROCESSING_STATUS,
        started_at: startedAt,
      });

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

      const resolvedSender =
        explicitSender || (await resolveDispatchSender(job.data.whatsapp_instance_id, { whatsappInstancesRepository }));
      const executeDelivery = createDeliveryExecutor({
        drive,
        jobData: job.data,
        logger,
        sender: resolvedSender,
        captionReviewService,
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
          trilhaId: job.data.trilha_id,
          sender: executeDelivery,
        });

        delivery = result.result;
        progress = result.progress;
      } else {
        delivery = await executeDelivery();
        progress = await registerDispatchProgress(job.data, progressRepository, groupsRepository);
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

      await maybeNotifyCampaignFinished(job.data, {
        campaignsRepository,
        campaignGroupsRepository,
        notificationsService,
        logger,
      });

      return {
        status: DISPATCH_SUCCESS_STATUS,
        delivery,
        progress,
        started_at: startedAt,
        completed_at: completedAt,
      };
    } catch (error) {
      const failedAt = new Date().toISOString();

      await job
        .updateData({
          ...job.data,
          status: DISPATCH_FAILED_STATUS,
          started_at: startedAt,
          failed_at: failedAt,
          error_message: error.message,
        })
        .catch((updateDataError) => {
          console.error(
            JSON.stringify({
              event: "dispatch.update_data_failed",
              job_id: job.id,
              error_message: updateDataError.message,
            })
          );
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

      await notificationsService
        .notifyDispatchFailure({
          campaignId: job.data.campaign_id,
          groupId: job.data.group_id,
          videoId: job.data.video_id,
          errorMessage: error.message,
        })
        .catch((notifyError) => {
          console.error(
            JSON.stringify({
              event: "dispatch.notification_failed",
              job_id: job.id,
              error_message: notifyError.message,
            })
          );
        });

      await maybeNotifyCampaignFinished(job.data, {
        campaignsRepository,
        campaignGroupsRepository,
        notificationsService,
        logger,
      });

      throw error;
    }
  };
}

const dispatchWorker = createDispatchProcessor({
  captionReviewService: defaultCaptionReviewService,
  dispatchConsistencyService: defaultDispatchConsistencyService,
  videoCaptionsService: defaultVideoCaptionsService,
});

function createDispatchWorker(options = {}) {
  const {
    sender,
    videoDownloader = downloadFromDrive,
    drive,
    videoCatalogRepository,
    progressRepository = groupVideoProgressRepository,
    whatsappInstancesRepository,
    dispatchConsistencyService = defaultDispatchConsistencyService,
    captionReviewService = defaultCaptionReviewService,
    videoCaptionsService = defaultVideoCaptionsService,
    campaignsRepository,
    campaignGroupsRepository,
    notificationsService,
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
      whatsappInstancesRepository,
      dispatchConsistencyService,
      captionReviewService,
      videoCaptionsService,
      campaignsRepository,
      campaignGroupsRepository,
      notificationsService,
      logger,
    }),
    {
      lockDuration: resolveDispatchJobTimeoutMs(),
      ...workerOptions,
    }
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
  maybeNotifyCampaignFinished,
  markDispatchCaptionUsed,
  prepareDispatchCaptionBeforeQueue,
  registerDispatchProgress,
  resolveDispatchSender,
  resolveVideoTranscript,
  resolveDispatchCaption,
  get dispatchQueue() {
    return getDispatchQueue();
  },
};
