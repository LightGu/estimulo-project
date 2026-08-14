const { createQueue, createQueueEvents, createWorker } = require("./bullmq");
const { queueNames } = require("./names");
const { addDispatchJob } = require("./dispatch");
const defaultDispatchLogsRepository = require("../repositories/dispatch-logs.repository");
const defaultGroupsRepository = require("../repositories/groups.repository");
const defaultCampaignsRepository = require("../repositories/campaigns.repository");
const defaultSettingsService = require("../services/settings.service");

const DISPATCH_FAILURE_RETRY_JOB_NAME = "dispatch-failure-retry-sweep";
const DISPATCH_FAILURE_RETRY_SCHEDULE_KEY = "dispatch-failure-retry-sweep";
const DEFAULT_SWEEP_EVERY_MS = 5 * 60 * 1000;
const MAX_RETRY_ATTEMPTS = 3;
// Teto de reenvios por sweep. Cada reenvio que falha na primeira tentativa gera
// uma notificacao de falha no WhatsApp, entao um backlog acumulado precisa ser
// drenado em lotes ao longo de varios sweeps em vez de tudo de uma vez.
const MAX_RETRIES_PER_SWEEP = 25;
const FAILED_STATUS = "falhou";
// Falhas que nao mudam de resultado ao repetir o mesmo envio. HTTP 413 e o caso
// concreto: o payload em base64 passa do limite de corpo da Evolution API, entao
// cada retry so repete o download do video do Drive e a montagem do mesmo
// payload recusado — ate esgotar MAX_RETRY_ATTEMPTS. Sem legenda aprovada ou com
// credencial/grupo invalidos vale o mesmo raciocinio.
// "Nao confirmou a entrega" tambem entra aqui, e por um motivo diferente dos
// outros: nesse caso a Evolution ACEITOU o envio e a midia ja subiu para o
// WhatsApp. Reenviar nao muda o ACK (para grupo ele simplesmente nao existe - ver
// services/delivery-confirmation.js) e arrisca postar o mesmo video de novo no
// grupo que ja recebeu. Logs antigos com essa mensagem, gravados antes de a regra
// de grupo ser corrigida, sao falso-negativo: precisam ficar de fora do sweep.
const PERMANENT_FAILURE_PATTERNS = [
  /HTTP 413/i,
  /HTTP 40[0134]/i,
  /HTTP 41[35]/i,
  /HTTP 422/i,
  /excede o limite/i,
  /entity too large/i,
  /nao confirmou a entrega/i,
];

function isPermanentFailureMessage(message) {
  const text = String(message || "");

  return PERMANENT_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

let dispatchFailureRetryQueueInstance;

function getDispatchFailureRetryQueue() {
  if (!dispatchFailureRetryQueueInstance) {
    dispatchFailureRetryQueueInstance = createQueue(queueNames.dispatchFailureRetry);
  }

  return dispatchFailureRetryQueueInstance;
}

async function scheduleDispatchFailureRetrySweep(options = {}) {
  const everyMs = Number(options.every_ms || options.everyMs || DEFAULT_SWEEP_EVERY_MS);

  return getDispatchFailureRetryQueue().add(
    DISPATCH_FAILURE_RETRY_JOB_NAME,
    {},
    {
      repeat: {
        key: DISPATCH_FAILURE_RETRY_SCHEDULE_KEY,
        every: everyMs,
      },
      removeOnComplete: true,
      removeOnFail: true,
    }
  );
}

function buildRetryJobData(log) {
  const group = log.groups || {};
  const video = log.video_catalog || {};

  return {
    group_id: group.evolution_group_id,
    progress_group_id: log.group_id,
    campaign_id: log.campaign_id,
    video_id: log.video_id,
    trilha_id: group.trilha_id,
    drive_file_id: video.drive_file_id,
    video_catalog: video.drive_file_id ? video : undefined,
    // Sem drive_file_id nem video_id resolvivel via catalogo, cai no link_video
    // legado; resolveDispatchCaption/selectCaptionForVideo escolhem a legenda
    // automaticamente a partir do video_id no reprocessamento.
    link_video: video.drive_file_id ? undefined : video.link_video,
    // Propagado ate o dispatch worker para que ele so notifique a falha uma vez
    // (na primeira tentativa), em vez de reenviar a mesma notificacao a cada
    // sweep de retry.
    retry_count: log.retry_count || 0,
    scheduled_at: new Date(),
  };
}

// Varre logs de dispatch com status "falhou" e reenfileira o envio, ate um
// limite de tentativas. Reaproveita o log existente (markRetrying) em vez de
// deixar dispatch-consistency criar um novo attempt log para o mesmo par
// campaign/group/video.
function createDispatchFailureRetryProcessor(options = {}) {
  const {
    dispatchLogsRepository = defaultDispatchLogsRepository,
    groupsRepository = defaultGroupsRepository,
    campaignsRepository = defaultCampaignsRepository,
    settingsService = defaultSettingsService,
    enqueueDispatch = addDispatchJob,
    logger = console,
  } = options;

  // Sem isto, o sweep reenfileirava um "falhou" mesmo com a campanha ja
  // pausada/cancelada pelo usuario - o reenvio automatico driblava a acao
  // manual. So busca o status de campanhas distintas do lote, nao uma a uma.
  async function filterOutPausedOrCancelledCampaigns(logs) {
    if (!logs.length || typeof campaignsRepository.findById !== "function") {
      return logs;
    }

    const campaignIds = [...new Set(logs.map((log) => log.campaign_id).filter(Boolean))];
    const campaigns = await Promise.all(
      campaignIds.map((campaignId) => campaignsRepository.findById(campaignId).catch(() => null))
    );
    const statusByCampaignId = new Map(
      campaigns.filter(Boolean).map((campaign) => [campaign.id, campaign.status])
    );

    return logs.filter((log) => {
      const status = statusByCampaignId.get(log.campaign_id);
      return status !== "pausado" && status !== "cancelado";
    });
  }

  return async function dispatchFailureRetryWorker() {
    const dispatchRules = await settingsService.getDispatchRulesSettings();

    if (!dispatchRules.auto_retry_failures) {
      return { checked: 0, retried: 0 };
    }

    // O filtro por retry_count e o teto de itens por sweep vao para o banco: um
    // backlog grande de falhas era carregado inteiro e reenfileirado de uma vez,
    // e cada reenvio que falhava disparava uma notificacao no WhatsApp.
    const failedLogs = await dispatchLogsRepository.listFailedForRetry({
      max_retry_count: MAX_RETRY_ATTEMPTS,
      limit: MAX_RETRIES_PER_SWEEP,
    });
    // Rede de seguranca: o filtro acima ja vem do banco, mas manter a checagem
    // aqui evita reprocessar logs caso a query seja trocada/mockada.
    const permanentLogs = failedLogs.filter((log) => isPermanentFailureMessage(log.mensagem_erro));
    const retryableCandidates = failedLogs
      .filter((log) => (log.retry_count || 0) < MAX_RETRY_ATTEMPTS)
      .filter((log) => !isPermanentFailureMessage(log.mensagem_erro))
      .slice(0, MAX_RETRIES_PER_SWEEP);
    const retryableLogs = await filterOutPausedOrCancelledCampaigns(retryableCandidates);

    for (const log of permanentLogs) {
      logger.warn &&
        logger.warn(
          JSON.stringify({
            event: "dispatch_failure_retry.skipped_permanent",
            log_id: log.id,
            campaign_id: log.campaign_id,
            group_id: log.group_id,
            video_id: log.video_id,
            error_message: log.mensagem_erro,
            note: "falha nao muda de resultado com reenvio identico; exige correcao (ex.: reduzir o video)",
          })
        );
    }

    if (retryableLogs.length >= MAX_RETRIES_PER_SWEEP) {
      logger.warn &&
        logger.warn(
          JSON.stringify({
            event: "dispatch_failure_retry.batch_capped",
            batch_size: retryableLogs.length,
            max_per_sweep: MAX_RETRIES_PER_SWEEP,
            note: "backlog restante sera drenado nos proximos sweeps",
          })
        );
    }

    let retried = 0;

    for (const log of retryableLogs) {
      try {
        const group = log.groups ? log.groups : await groupsRepository.findById(log.group_id);

        if (!group || !group.evolution_group_id) {
          continue;
        }

        const nextRetryCount = (log.retry_count || 0) + 1;

        await dispatchLogsRepository.markRetrying(log.id, nextRetryCount);
        await enqueueDispatch(
          { ...buildRetryJobData({ ...log, groups: group, retry_count: nextRetryCount }) },
          { removeOnComplete: false, removeOnFail: false }
        );

        retried += 1;

        logger.info &&
          logger.info(
            JSON.stringify({
              event: "dispatch_failure_retry.requeued",
              log_id: log.id,
              campaign_id: log.campaign_id,
              group_id: log.group_id,
              video_id: log.video_id,
              retry_count: nextRetryCount,
            })
          );
      } catch (error) {
        logger.error &&
          logger.error(
            JSON.stringify({
              event: "dispatch_failure_retry.requeue_failed",
              log_id: log.id,
              error_message: error.message,
            })
          );
      }
    }

    return { checked: retryableLogs.length, retried, skipped_permanent: permanentLogs.length };
  };
}

function createDispatchFailureRetryWorker(options = {}) {
  return createWorker(queueNames.dispatchFailureRetry, createDispatchFailureRetryProcessor(options), options);
}

function createDispatchFailureRetryEvents(options = {}) {
  return createQueueEvents(queueNames.dispatchFailureRetry, options);
}

module.exports = {
  DISPATCH_FAILURE_RETRY_JOB_NAME,
  DISPATCH_FAILURE_RETRY_SCHEDULE_KEY,
  MAX_RETRIES_PER_SWEEP,
  MAX_RETRY_ATTEMPTS,
  PERMANENT_FAILURE_PATTERNS,
  buildRetryJobData,
  isPermanentFailureMessage,
  createDispatchFailureRetryProcessor,
  createDispatchFailureRetryWorker,
  createDispatchFailureRetryEvents,
  scheduleDispatchFailureRetrySweep,
  get dispatchFailureRetryQueue() {
    return getDispatchFailureRetryQueue();
  },
};
