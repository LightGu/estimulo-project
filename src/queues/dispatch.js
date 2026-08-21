const { createQueue, createQueueEvents, createWorker } = require("./bullmq");
const { queueNames } = require("./names");
const { buildJitteredDispatchSchedule } = require("./dispatch-jitter");
const { resolveInstanceSender } = require("../services/evolution-instance-sender");
const { assertDeliveryConfirmed, confirmProviderDelivery } = require("../services/delivery-confirmation");
const { evolutionConfig } = require("../config/evolution");
const { downloadFromDrive } = require("../services/google-drive-video-download");
const {
  base64Length,
  compressVideoToFitBase64Budget,
  isMp4Container,
  normalizeVideoContainerToMp4,
} = require("../services/video-compression");
const defaultCaptionReviewService = require("../services/caption-review.service");
const defaultDispatchConsistencyService = require("../services/dispatch-consistency.service");
const defaultVideoCaptionsService = require("../services/video-captions.service");
const groupVideoProgressRepository = require("../repositories/group-video-progress.repository");
const defaultVideoCatalogRepository = require("../repositories/video-catalog.repository");
const defaultGroupsRepository = require("../repositories/groups.repository");
const defaultCampaignsRepository = require("../repositories/campaigns.repository");
const defaultCampaignGroupsRepository = require("../repositories/campaign-groups.repository");
const defaultNotificationsService = require("../services/notifications.service");
const defaultInAppNotificationsService = require("../services/in-app-notifications.service");
const defaultTrilhasRepository = require("../repositories/trilhas.repository");
const { resolveGroupTrailId, selectNextApprovedUnsentVideo } = require("../services/group-video-flow");

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
    forced_next_video_id: params.forced_next_video_id || (params.group && params.group.forced_next_video_id) || undefined,
    never_repeat_video: params.never_repeat_video,
    auto_generate_caption: params.auto_generate_caption,
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
      // Ja passou pela revisao factual na Etapa 2 (campaign-video-captions.service
      // chama selectCaptionForVideo com requireCaptionReview). Revisar de novo aqui
      // era uma segunda chamada ao Gemini por grupo sobre exatamente o mesmo par
      // legenda/transcricao — o que dobrava o consumo da cota diaria e fazia o envio
      // falhar por 429 justamente com a legenda pronta.
      reviewed: true,
      text: fallbackCaption,
    };
  }

  if (!jobData.video_id || !captionSelector || typeof captionSelector.selectCaptionForVideo !== "function") {
    return {
      caption: null,
      generated: false,
      reviewed: false,
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
      reviewed: false,
      text: fallbackCaption,
    };
  }

  if (!selected || !selected.text) {
    return {
      caption: null,
      generated: false,
      reviewed: false,
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

  // selectCaptionForVideo ja revisou a legenda quando requireCaptionReview estava
  // ligado (tanto a reaproveitada do banco quanto a gerada agora).
  return { ...selected, reviewed: Boolean(options.requireCaptionReview) };
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

// Sobra reservada para o resto do JSON do sendMedia (number, mediatype, mimetype,
// fileName e a legenda) alem do campo `media` em base64.
const DISPATCH_PAYLOAD_ENVELOPE_RESERVE_BYTES = 64 * 1024;

function isDispatchVideoCompressionEnabled() {
  return String(process.env.EVOLUTION_MEDIA_COMPRESSION_ENABLED || "true").toLowerCase() !== "false";
}

function resolveDispatchMediaBase64Budget(config = evolutionConfig) {
  const limitBytes = Number(config.maxMediaPayloadBytes);

  if (!Number.isFinite(limitBytes) || limitBytes <= 0) {
    return null;
  }

  return limitBytes - DISPATCH_PAYLOAD_ENVELOPE_RESERVE_BYTES;
}

// O WhatsApp so exibe video de container mp4 de forma confiavel; .mov, .mkv,
// .avi etc sao aceitos pela Evolution API (HTTP 200) mas o destinatario nao
// recebe nada visivel, sem erro do nosso lado — descoberto apos um disparo em
// campanha onde grupos que receberiam .mov simplesmente nao viram o video,
// enquanto o mesmo arquivo enviado individualmente funcionou. Normaliza para
// mp4 (remux rapido, com fallback para recompressao) antes do envio.
async function normalizeDownloadedVideoContainer(downloadedVideo, options = {}) {
  const { config = evolutionConfig, jobData = {}, logger = console, normalizeContainer = normalizeVideoContainerToMp4 } =
    options;

  if (!downloadedVideo || !Buffer.isBuffer(downloadedVideo.bytes) || isMp4Container(downloadedVideo)) {
    return downloadedVideo;
  }

  if (!isDispatchVideoCompressionEnabled()) {
    logger.warn &&
      logger.warn(
        JSON.stringify({
          event: "dispatch.video_container_normalization.skipped",
          campaign_id: jobData.campaign_id,
          group_id: jobData.group_id,
          video_id: jobData.video_id,
          source_mime_type: downloadedVideo.mime_type,
          reason: "EVOLUTION_MEDIA_COMPRESSION_ENABLED=false",
        })
      );

    return downloadedVideo;
  }

  logger.info &&
    logger.info(
      JSON.stringify({
        event: "dispatch.video_container_normalization.started",
        campaign_id: jobData.campaign_id,
        group_id: jobData.group_id,
        progress_group_id: jobData.progress_group_id,
        video_id: jobData.video_id,
        source_mime_type: downloadedVideo.mime_type,
        bytes: downloadedVideo.bytes.length,
      })
    );

  const maxBase64Bytes = resolveDispatchMediaBase64Budget(config);
  const normalized = await normalizeContainer(downloadedVideo, {
    logger,
    maxBase64Bytes: maxBase64Bytes || base64Length(downloadedVideo.bytes.length),
  });

  if (normalized !== downloadedVideo) {
    // Libera os bytes originais assim que a versao mp4 existe, para nao manter
    // as duas versoes na memoria do worker durante o upload.
    downloadedVideo.bytes = undefined;
  }

  logger.info &&
    logger.info(
      JSON.stringify({
        event: "dispatch.video_container_normalization.completed",
        campaign_id: jobData.campaign_id,
        group_id: jobData.group_id,
        progress_group_id: jobData.progress_group_id,
        video_id: jobData.video_id,
        remuxed: Boolean(normalized.remuxed),
        compressed: Boolean(normalized.compressed),
        bytes: normalized.bytes.length,
      })
    );

  return normalized;
}

// A Evolution API recusa com HTTP 413 qualquer corpo acima do limite do
// body-parser dela (136 MB, fixo no bundle). Como a midia viaja em base64
// (+33% sobre o arquivo), video a partir de ~102 MB nunca era entregue: o job
// baixava o arquivo do Drive, montava o payload e tomava 413. Aqui o video e
// reduzido para caber antes do envio.
async function fitDownloadedVideoToEvolutionLimit(downloadedVideo, options = {}) {
  const { compressVideo = compressVideoToFitBase64Budget, config = evolutionConfig, jobData = {}, logger = console } =
    options;

  const containerNormalized = await normalizeDownloadedVideoContainer(downloadedVideo, options);

  if (!containerNormalized || !Buffer.isBuffer(containerNormalized.bytes)) {
    return containerNormalized;
  }

  const maxBase64Bytes = resolveDispatchMediaBase64Budget(config);

  if (!maxBase64Bytes || base64Length(containerNormalized.bytes.length) <= maxBase64Bytes) {
    return containerNormalized;
  }

  if (!isDispatchVideoCompressionEnabled()) {
    logger.warn &&
      logger.warn(
        JSON.stringify({
          event: "dispatch.video_compression.skipped",
          campaign_id: jobData.campaign_id,
          group_id: jobData.group_id,
          video_id: jobData.video_id,
          bytes: containerNormalized.bytes.length,
          max_base64_bytes: maxBase64Bytes,
          reason: "EVOLUTION_MEDIA_COMPRESSION_ENABLED=false",
        })
      );

    return containerNormalized;
  }

  logger.info &&
    logger.info(
      JSON.stringify({
        event: "dispatch.video_compression.started",
        campaign_id: jobData.campaign_id,
        group_id: jobData.group_id,
        progress_group_id: jobData.progress_group_id,
        video_id: jobData.video_id,
        bytes: containerNormalized.bytes.length,
        base64_bytes: base64Length(containerNormalized.bytes.length),
        max_base64_bytes: maxBase64Bytes,
      })
    );

  const compressed = await compressVideo(containerNormalized, { logger, maxBase64Bytes });

  if (compressed !== containerNormalized) {
    // Libera os bytes originais (~125 MB) assim que o video reduzido existe, para
    // nao manter as duas versoes na memoria do worker durante o upload.
    containerNormalized.bytes = undefined;
  }

  logger.info &&
    logger.info(
      JSON.stringify({
        event: "dispatch.video_compression.completed",
        campaign_id: jobData.campaign_id,
        group_id: jobData.group_id,
        progress_group_id: jobData.progress_group_id,
        video_id: jobData.video_id,
        bytes: compressed.bytes.length,
        base64_bytes: base64Length(compressed.bytes.length),
      })
    );

  return compressed;
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

// Mesma resolucao de instancia usada pelo caminho de mensagem pontual
// agendada; a implementacao vive em services/evolution-instance-sender.js.
const resolveDispatchSender = resolveInstanceSender;

function createDeliveryExecutor(params = {}) {
  const {
    compressVideo = compressVideoToFitBase64Budget,
    confirmDelivery = confirmProviderDelivery,
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
          autoGenerateCaption: jobData.auto_generate_caption,
          campaign_id: jobData.campaign_id,
          group_id: jobData.group_id,
          progress_group_id: jobData.progress_group_id,
        });
      })();
      const [downloadedVideoResult, captionSelection] = await Promise.all([downloadPromise, captionPromise]);
      const transcript = await transcriptPromise;

      downloadedVideo = downloadedVideoResult;

      // Revisa apenas o que ainda nao foi revisado: legenda vinda do fallback
      // (jobData.legenda sem passar por selectCaptionForVideo). Legenda ja aprovada
      // na Etapa 2 ou revisada agora dentro de selectCaptionForVideo nao gasta uma
      // segunda chamada de IA aqui.
      if (
        jobData.video_id &&
        captionReviewService &&
        !captionSelection.reviewed &&
        typeof captionReviewService.assertCaptionApproved === "function"
      ) {
        await captionReviewService.assertCaptionApproved({
          caption: captionSelection.text,
          transcript,
          campaign_id: jobData.campaign_id,
          group_id: jobData.group_id,
          progress_group_id: jobData.progress_group_id,
          video_id: jobData.video_id,
        });
      }
      downloadedVideo = await fitDownloadedVideoToEvolutionLimit(downloadedVideo, {
        compressVideo,
        jobData,
        logger,
      });
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
      // Recusa explicita da Evolution (HTTP 200 com corpo de erro). Ficava so
      // dentro de dispatch-consistency, o que deixava o caminho sem consistencia
      // (disparo de teste, campanha sem video_id em UUID) aceitar qualquer coisa.
      assertDeliveryConfirmed(result);
      // Aceite nao e entrega: espera o ACK do WhatsApp antes de deixar o job
      // terminar com sucesso. Se o ACK nao vier, isto lanca e o log vai para
      // "falhou" - e o que impede o relatorio de mostrar "enviado" para uma
      // mensagem que nunca chegou ao grupo.
      result.delivery_confirmation = await confirmDelivery(result, {
        logger,
        context: {
          campaign_id: jobData.campaign_id,
          group_id: jobData.group_id,
          progress_group_id: jobData.progress_group_id,
          video_id: jobData.video_id,
        },
      });
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
  groupsRepository = defaultGroupsRepository,
  options = {}
) {
  const groupId = jobData.progress_group_id;
  const videoId = jobData.video_id;

  if (!groupId || !videoId) {
    return null;
  }

  const duplicate = await repository.hasDuplicate(groupId, videoId);
  const trilhaId = jobData.trilha_id || jobData.trilhaId || null;
  let record;
  let wasDuplicate = false;

  if (duplicate) {
    if (options.neverRepeatVideo === false) {
      record = await repository.upsertDelivery({
        group_id: groupId,
        video_id: videoId,
        trilha_id: trilhaId,
      });
    } else {
      wasDuplicate = true;
    }
  } else {
    record = await repository.registerDelivery({
      group_id: groupId,
      video_id: videoId,
      trilha_id: trilhaId,
    });
  }

  if (wasDuplicate) {
    return {
      duplicate: true,
      record: null,
    };
  }

  const groupUpdate = { ...(trilhaId ? { trilha_id: trilhaId } : {}) };

  if (jobData.forced_next_video_id && jobData.forced_next_video_id === videoId) {
    groupUpdate.forced_next_video_id = null;
  }

  if (Object.keys(groupUpdate).length > 0) {
    await groupsRepository.update(groupId, groupUpdate);
  }

  return {
    duplicate: false,
    record,
  };
}

// Roda logo apos o envio de um video ser registrado em group_video_progress: e o
// unico ponto que sabe, no exato momento da entrega, se aquele era o ultimo video
// aprovado e nao enviado da trilha do grupo. O campaignTriggerWorker so reavalia
// isso quando o cron da campanha roda de novo, o que pode nunca acontecer depois
// da trilha terminar.
async function maybeNotifyTrailFinished(jobData, dependencies = {}) {
  const {
    groupsRepository = defaultGroupsRepository,
    trilhasRepository = defaultTrilhasRepository,
    videoCatalogRepository = defaultVideoCatalogRepository,
    progressRepository = groupVideoProgressRepository,
    inAppNotificationsService = defaultInAppNotificationsService,
    logger = console,
  } = dependencies;

  const groupId = jobData.progress_group_id;

  if (!groupId) {
    return;
  }

  try {
    const group = await groupsRepository.findById(groupId);
    const trilhaId = jobData.trilha_id || jobData.trilhaId || (group && resolveGroupTrailId(group));

    if (!group || !trilhaId) {
      return;
    }

    const [delivered, links] = await Promise.all([
      progressRepository.listDelivered(groupId),
      trilhasRepository.listVideoLinksByTrilha(trilhaId),
    ]);

    if (!links.length) {
      return;
    }

    const approved = typeof videoCatalogRepository.listApproved === "function"
      ? await videoCatalogRepository.listApproved()
      : [];
    const approvedById = new Map(approved.map((video) => [video.id, video]));
    const trailVideos = links
      .filter((link) => approvedById.has(link.video_id))
      .map((link) => ({ ...approvedById.get(link.video_id), ordem: link.ordem }));
    const sentVideoIds = delivered.map((item) => item.video_id).filter(Boolean);

    const nextVideo = selectNextApprovedUnsentVideo({
      group,
      sentVideoIds,
      videos: trailVideos,
    });

    if (nextVideo) {
      return;
    }

    await inAppNotificationsService.notifyTrailFinished({
      groupId,
      groupName: group.nome || group.name,
      trilhaLabel: group.trilha_override || group.segmento,
    });
  } catch (error) {
    logger.error &&
      logger.error(
        JSON.stringify({
          event: "dispatch.trail_finished_check_failed",
          group_id: groupId,
          error_message: error.message,
        })
      );
  }
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
    compressVideo = compressVideoToFitBase64Budget,
    confirmDelivery = confirmProviderDelivery,
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
    trilhasRepository = defaultTrilhasRepository,
    inAppNotificationsService = defaultInAppNotificationsService,
    logger = console,
  } = options;

  return async function dispatchWorker(job) {
    const startedAt = new Date().toISOString();

    // A checagem de campanha pausada fica dentro de dispatch-consistency.js
    // (reaproveita o fetch que ensureDispatchEntities ja faz, sem round-trip
    // extra) - colocar aqui tambem serializava essa consulta antes do download
    // do video e da resolucao da legenda, que precisam comecar em paralelo.
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
        compressVideo,
        confirmDelivery,
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
          neverRepeatVideo: job.data.never_repeat_video,
          forcedNextVideoId: job.data.forced_next_video_id,
          sender: executeDelivery,
        });

        delivery = result.result;
        progress = result.progress;
      } else {
        delivery = await executeDelivery();
        progress = await registerDispatchProgress(job.data, progressRepository, groupsRepository, {
          neverRepeatVideo: job.data.never_repeat_video,
        });
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

      if (progress && !progress.duplicate) {
        await maybeNotifyTrailFinished(job.data, {
          groupsRepository,
          trilhasRepository,
          videoCatalogRepository: videoCatalogRepository || defaultVideoCatalogRepository,
          progressRepository,
          inAppNotificationsService,
          logger,
        });
      }

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
          // Marcado pelo wrapper da Evolution (ver PERMANENT_ERROR_STATUSES):
          // indica que o sweep de dispatch-failure-retry vai ignorar este log em
          // vez de gastar tentativas repetindo um envio que nao pode dar certo.
          permanent: Boolean(error.permanent),
          error_code: error.code,
        })
      );

      // So notifica na primeira falha (retry_count 0): o sweep de
      // dispatch-failure-retry reenfileira o mesmo log ate MAX_RETRY_ATTEMPTS
      // vezes, e sem essa checagem cada nova tentativa falha reenviaria a
      // mesma notificacao de falha ao WhatsApp.
      if (!job.data.retry_count) {
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
      }

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
    compressVideo = compressVideoToFitBase64Budget,
    confirmDelivery,
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
    trilhasRepository,
    inAppNotificationsService,
    logger = console,
    ...workerOptions
  } = options;

  return createWorker(
    queueNames.dispatch,
    createDispatchProcessor({
      sender,
      compressVideo,
      confirmDelivery,
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
      trilhasRepository,
      inAppNotificationsService,
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
  fitDownloadedVideoToEvolutionLimit,
  resolveDispatchMediaBase64Budget,
  maybeNotifyCampaignFinished,
  maybeNotifyTrailFinished,
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
