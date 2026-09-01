const { createQueue, createQueueEvents, createWorker } = require("./bullmq");
const { queueNames } = require("./names");
const { UUID_PATTERN } = require("../utils/uuid");
const { buildJitteredDispatchSchedule } = require("./dispatch-jitter");
const { resolveInstanceSender } = require("../services/evolution-instance-sender");
const { assertDeliveryConfirmed, confirmProviderDelivery } = require("../services/delivery-confirmation");
const { compressVideoToFitBase64Budget } = require("../services/video-compression");
const { downloadFromDrive } = require("../services/google-drive-video-download");
const {
  markDispatchCaptionUsed,
  prepareDispatchCaptionBeforeQueue,
  resolveDispatchCaption,
  resolveVideoTranscript,
} = require("./dispatch-caption");
const defaultCaptionReviewService = require("../services/caption-review.service");
const defaultVideoCaptionsService = require("../services/video-captions.service");
const defaultVideoCatalogRepository = require("../repositories/video-catalog.repository");
const {
  assertDownloadedVideoForDispatch,
  buildDispatchDeliveryPayload,
  fitDownloadedVideoToEvolutionLimit,
  releaseTemporaryDispatchMedia,
  resolveDispatchMediaBase64Budget,
} = require("./dispatch-media");
const defaultDispatchConsistencyService = require("../services/dispatch-consistency.service");
const groupVideoProgressRepository = require("../repositories/group-video-progress.repository");
const defaultGroupsRepository = require("../repositories/groups.repository");
const defaultCampaignsRepository = require("../repositories/campaigns.repository");
const defaultCampaignGroupsRepository = require("../repositories/campaign-groups.repository");
const defaultNotificationsService = require("../services/notifications.service");
const defaultInAppNotificationsService = require("../services/in-app-notifications.service");
const defaultTrilhasRepository = require("../repositories/trilhas.repository");
const defaultDispatchLogsRepository = require("../repositories/dispatch-logs.repository");
const {
  resolveCampaignBlockReason,
  resolveJobStaleReason,
  resolveMaxVideoDispatchDelayMs,
} = require("../services/dispatch-staleness");
const { resolveGroupTrailId, selectNextApprovedUnsentVideo } = require("../services/group-video-flow");

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
    // buildRetryJobData (dispatch-failure-retry.js) monta este campo e o
    // comentario de la diz que ele e "propagado ate o dispatch worker", mas ele
    // era descartado aqui. Duas consequencias reais: (1) a checagem de
    // `!job.data.retry_count` mais abaixo, que existe para notificar a falha
    // so na primeira tentativa, via sempre undefined e renotificava a cada
    // sweep; (2) o jobId deterministico nao conseguiria distinguir um retry do
    // envio original - que preserva o mesmo scheduled_at de proposito - e a
    // BullMQ descartaria o retry em silencio.
    retry_count: Number(params.retry_count) || 0,
  };
}

// Identidade logica de um envio de video: campanha + grupo + video + horario.
//
// Serve de `jobId` na BullMQ, que recusa silenciosamente um add() com jobId ja
// existente. Isto e a unica protecao contra envio duplicado no ramo SEM
// dispatch-consistency (campanha legada por link_video, ou retry sem video_id
// resolvivel): la nao existe log de tentativa, nem claimForSend, e
// registerDispatchProgress retorna null cedo por falta de video_id - nem o
// UNIQUE (group_id, video_id) de group_video_progress se aplica. Uma reentrega
// por job travado (a BullMQ recupera jobs `active` de um processo que morreu,
// com maxStalledCount padrao 1, independente de attempts) postava o video duas
// vezes no grupo.
//
// `scheduled_at` entra na chave de proposito: dois envios do mesmo trio em
// horarios diferentes sao legitimos (reagendamento, campanha recorrente) e
// precisam de jobIds distintos. So a duplicata exata - mesmo trio, mesmo
// horario, mesma tentativa - e' recusada. Como jobs completos saem do Redis em
// 24h (removeOnComplete em bullmq.js), reenfileirar depois disso volta a ser
// aceito.
//
// `retry_count` e' OBRIGATORIO na chave: o sweep de retry
// (dispatch-failure-retry.js) reenfileira preservando o scheduled_at ORIGINAL
// de proposito, para a trava de atraso continuar ancorada no horario real. Sem
// retry_count aqui, todo retry colidiria com o jobId do envio que falhou e a
// BullMQ o descartaria em silencio - quebrando o reprocessamento inteiro.
//
// O fallback drive_file_id -> link_video cobre o caso sem video_id, que e
// justamente o ramo desprotegido.
function buildDispatchJobId(jobData = {}) {
  const videoKey = jobData.video_id || jobData.drive_file_id || jobData.link_video || "sem-video";

  // A BullMQ so aceita ":" num jobId customizado se o resultado tiver
  // EXATAMENTE 3 segmentos (reservado para o formato interno de repeatable
  // jobs - ver Job.validateOptions em bullmq/dist/cjs/classes/job.js). Com 6
  // componentes e ":" tambem podendo vir de dentro de scheduled_at (data ISO,
  // sempre tem ":") ou de link_video (URL, pode ter "://"), o join(":")
  // original violava essa regra em TODO envio de video - o worker de
  // campaign-trigger falhava com "Custom Id cannot contain :" antes mesmo de
  // criar o primeiro job da campanha, e nenhum grupo recebia nada.
  //
  // A regra olha o ID inteiro, nao separador por separador: um "://" dentro
  // de link_video (fallback de videoKey) continua sendo ":" ali dentro mesmo
  // trocando o separador externo para "|". Por isso todo componente passa por
  // replace(/:/g, "_") antes de juntar - custa nada, e' so identidade de
  // deduplicacao, nunca exibido nem usado para parsear de volta.
  const sanitize = (value) => String(value).replace(/:/g, "_");

  return [
    "dispatch",
    sanitize(jobData.campaign_id),
    sanitize(jobData.progress_group_id || jobData.group_id),
    sanitize(videoKey),
    sanitize(jobData.scheduled_at),
    `r${Number(jobData.retry_count) || 0}`,
  ].join("|");
}

function buildDispatchJobOptions(jobData, options = {}) {
  const scheduledTime = new Date(jobData.scheduled_at).getTime();
  const delay = Math.max(scheduledTime - Date.now(), 0);

  return {
    jobId: buildDispatchJobId(jobData),
    ...options,
    delay: options.delay ?? delay,
  };
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

// Registra no relatorio um envio que percorreu o caminho legado (sem
// dispatch-consistency). Esse ramo entregava o video ao grupo e nao tocava na
// tabela `logs`: o disparo chegava no WhatsApp e nao existia registro nenhum
// dele - foi assim que envios de teste de grupo ("manual-test", campaign_id que
// nao e UUID) sumiram do relatorio operacional.
//
// Best-effort por definicao: este caminho ja entregou a mensagem quando a
// funcao e chamada, entao falhar aqui nao pode derrubar o job e transformar um
// envio bem-sucedido em falha (o retry reenviaria o video ao grupo). Erros
// viram evento de log e nada mais.
//
// So grava quando campaign_id e progress_group_id sao UUID: logs.campaign_id e
// logs.group_id sao FKs, e um id sintetico como "manual-test" seria rejeitado
// pelo banco. Quando nao da para gravar, emite um evento explicito para que o
// envio nao registrado seja rastreavel no worker em vez de silencioso.
async function recordLegacyDispatchLog(jobData, dispatchLogs, status, mensagemErro, logger = console) {
  const campaignId = String(jobData.campaign_id || "");
  const groupId = String(jobData.progress_group_id || "");
  const canPersist = UUID_PATTERN.test(campaignId) && UUID_PATTERN.test(groupId);

  if (!canPersist || !dispatchLogs || typeof dispatchLogs.createLog !== "function") {
    logger.warn &&
      logger.warn(
        JSON.stringify({
          event: "dispatch.legacy_send_not_logged",
          campaign_id: jobData.campaign_id,
          progress_group_id: jobData.progress_group_id,
          video_id: jobData.video_id,
          status,
          reason: canPersist ? "dispatch_logs_indisponivel" : "campaign_id/group_id nao sao UUID",
        })
      );

    return null;
  }

  try {
    return await dispatchLogs.createLog({
      campaign_id: campaignId,
      group_id: groupId,
      video_id: UUID_PATTERN.test(String(jobData.video_id || "")) ? jobData.video_id : null,
      status,
      mensagem_erro: mensagemErro || null,
      horario_envio_planejado: jobData.scheduled_at || null,
      whatsapp_instance_id: jobData.whatsapp_instance_id || null,
    });
  } catch (error) {
    logger.error &&
      logger.error(
        JSON.stringify({
          event: "dispatch.legacy_dispatch_log_failed",
          campaign_id: jobData.campaign_id,
          progress_group_id: jobData.progress_group_id,
          error_message: error.message || String(error),
        })
      );

    return null;
  }
}

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

  // A mensagem ja foi enviada mesmo quando o registro de progresso e pulado
  // (repeticao com "nunca repetir video" ativo) - o forced_next_video_id
  // precisa ser limpo de qualquer forma, senao o proximo disparo tenta
  // reenviar o mesmo video forcado indefinidamente.
  const groupUpdate = { ...(trilhaId ? { trilha_id: trilhaId } : {}) };

  if (jobData.forced_next_video_id && jobData.forced_next_video_id === videoId) {
    groupUpdate.forced_next_video_id = null;
  }

  if (Object.keys(groupUpdate).length > 0) {
    await groupsRepository.update(groupId, groupUpdate);
  }

  if (wasDuplicate) {
    return {
      duplicate: true,
      record: null,
    };
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

// Cancela, best-effort, o log ainda pendente do trio campaign/group/video, para
// que o relatorio mostre "cancelado" em vez de deixar a linha presa em pendente
// quando o portao de entrada barra o envio. Nunca pode derrubar o job: o que
// importa e nao enviar.
async function cancelPendingLogForBlockedDispatch(jobData, dispatchLogs, reason, logger = console) {
  if (!dispatchLogs || typeof dispatchLogs.listByCampaign !== "function" || !jobData.campaign_id) {
    return null;
  }

  try {
    const logs = await dispatchLogs.listByCampaign(jobData.campaign_id);
    const pending = (logs || []).find(
      (entry) =>
        entry.status === "pendente" &&
        entry.group_id === jobData.progress_group_id &&
        (!jobData.video_id || entry.video_id === jobData.video_id)
    );

    if (!pending || typeof dispatchLogs.cancelIfPending !== "function") {
      return null;
    }

    return await dispatchLogs.cancelIfPending(pending.id, reason);
  } catch (error) {
    logger.error &&
      logger.error(
        JSON.stringify({
          event: "dispatch.cancel_blocked_log_failed",
          campaign_id: jobData.campaign_id,
          group_id: jobData.progress_group_id,
          video_id: jobData.video_id,
          error_message: error.message,
        })
      );

    return null;
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
    dispatchLogs = defaultDispatchLogsRepository,
    now = () => new Date(),
    logger = console,
  } = options;

  return async function dispatchWorker(job) {
    const startedAt = new Date().toISOString();

    // PORTAO DE ENTRADA (falha fechado) - nada acima disto faz I/O de envio.
    //
    // Trava de atraso no nivel do job, antes de qualquer download ou legenda.
    // Antes ela existia SO dentro de dispatch-consistency.js, comparada contra
    // log.horario_envio_planejado - que e nulo em todo log criado por
    // createAttemptLog. Resultado: o caminho de video ficava sem nenhuma trava
    // de atraso efetiva, e cada `docker compose up` reenviava para os grupos os
    // jobs que a BullMQ promovia de uma vez do estado `delayed`/`active`
    // (o Redis da infra persiste as filas). Aqui a checagem usa
    // job.data.scheduled_at, que TODO job desta fila tem preenchido.
    const staleReason = resolveJobStaleReason(job.data.scheduled_at, {
      maxDelayMs: resolveMaxVideoDispatchDelayMs(),
      now,
    });

    if (staleReason) {
      await cancelPendingLogForBlockedDispatch(job.data, dispatchLogs, staleReason, logger);
      await job
        .updateData({
          ...job.data,
          status: "cancelado",
          cancelled_at: new Date().toISOString(),
          cancel_reason: staleReason,
        })
        .catch(() => undefined);

      logger.warn &&
        logger.warn(
          JSON.stringify({
            event: "dispatch.cancelled_stale",
            job_id: job.id,
            campaign_id: job.data.campaign_id,
            group_id: job.data.group_id,
            progress_group_id: job.data.progress_group_id,
            video_id: job.data.video_id,
            scheduled_at: job.data.scheduled_at,
            reason: staleReason,
          })
        );

      return { status: "cancelado", reason: staleReason };
    }

    // A checagem de campanha pausada/cancelada vive dentro de
    // dispatch-consistency.js (reaproveita o fetch que ensureDispatchEntities ja
    // faz, sem round-trip extra). Mas quando a consistencia nao se aplica
    // (campaign/group/video que nao sao UUID), aquele caminho inteiro e pulado -
    // e com ele a checagem de status. Aqui ela e refeita so nesse caso, para que
    // nao exista caminho de envio sem essa trava.
    const useDispatchConsistency = canUseDispatchConsistency(job.data, dispatchConsistencyService);

    if (!useDispatchConsistency && UUID_PATTERN.test(String(job.data.campaign_id || ""))) {
      // Antes esta consulta terminava em `.catch(() => null)`, o que anulava a
      // propria trava que o comentario acima descreve: um erro transitorio do
      // Supabase virava `campaign = null`, resolveCampaignBlockReason devolvia
      // null e o video de uma campanha PAUSADA ou CANCELADA era enviado ao
      // grupo, sem nenhuma linha de log explicando o porque.
      //
      // Agora a falha de consulta e' distinguida de "campanha nao encontrada":
      // relanca-se o erro para o job falhar em vez de enviar. Falhar e'
      // recuperavel (o sweep de dispatch-failure-retry reprocessa, e o erro nao
      // casa com PERMANENT_FAILURE_PATTERNS); enviar por engano nao e'.
      let campaign = null;

      if (campaignsRepository && typeof campaignsRepository.findById === "function") {
        try {
          campaign = await campaignsRepository.findById(job.data.campaign_id);
        } catch (error) {
          logger.error &&
            logger.error(
              JSON.stringify({
                event: "dispatch.campaign_status_check_failed",
                job_id: job.id,
                campaign_id: job.data.campaign_id,
                error_message: error && error.message,
              })
            );

          throw new Error(
            `Nao foi possivel verificar o status da campanha antes do envio: ${error && error.message}`
          );
        }
      }

      const campaignBlockReason = resolveCampaignBlockReason(campaign);

      if (campaignBlockReason) {
        await cancelPendingLogForBlockedDispatch(job.data, dispatchLogs, campaignBlockReason, logger);
        await job
          .updateData({
            ...job.data,
            status: "cancelado",
            cancelled_at: new Date().toISOString(),
            cancel_reason: campaignBlockReason,
          })
          .catch(() => undefined);

        logger.warn &&
          logger.warn(
            JSON.stringify({
              event: "dispatch.skipped_campaign_not_active",
              job_id: job.id,
              campaign_id: job.data.campaign_id,
              group_id: job.data.group_id,
              campaign_status: campaign && campaign.status,
              reason: campaignBlockReason,
            })
          );

        return { status: "cancelado", reason: campaignBlockReason };
      }
    }

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
          // Fallback da trava de atraso lá dentro: todo log criado por
          // createAttemptLog nasce sem horario_envio_planejado, e sem este
          // valor a checagem de atraso ficava cega justamente nos logs novos.
          scheduledAt: job.data.scheduled_at,
          sender: executeDelivery,
          whatsappInstanceId: job.data.whatsapp_instance_id,
        });

        delivery = result.result;
        progress = result.progress;
      } else {
        // Caminho legado (campaign/group/video que nao sao todos UUID, ex.: o
        // "Enviar teste para este grupo", que usa campaign_id "manual-test").
        // Aqui nao existe log pendente criado antes, entao o registro e feito
        // depois do envio - o inverso do caminho de consistencia, mas e o
        // unico ponto em que se sabe o desfecho neste ramo.
        try {
          delivery = await executeDelivery();
        } catch (error) {
          await recordLegacyDispatchLog(job.data, dispatchLogs, "falhou", error.message || String(error), logger);
          throw error;
        }

        await recordLegacyDispatchLog(job.data, dispatchLogs, "enviado", null, logger);
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
  buildDispatchJobId,
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
