const { createQueue, createQueueEvents, createWorker } = require("./bullmq");
const { queueNames } = require("./names");
const defaultCampaignsRepository = require("../repositories/campaigns.repository");
const defaultSettingsService = require("../services/settings.service");
const defaultCampaignsService = require("../services/campaigns.service");

const DISPATCH_REVIEW_TIMEOUT_JOB_NAME = "dispatch-review-timeout-sweep";
const DISPATCH_REVIEW_TIMEOUT_SCHEDULE_KEY = "dispatch-review-timeout-sweep";
const DEFAULT_SWEEP_EVERY_MS = 60 * 1000;
const CAMPAIGN_STATUS_GENERATING_CAPTIONS = "gerando_legendas";
// Teto de idade para a confirmacao automatica.
//
// auto_send_after_timeout existe para "o revisor humano nao respondeu em N
// minutos, entao envie". Ele NAO existe para ressuscitar uma campanha
// abandonada: uma campanha parada em "gerando_legendas" ha dias foi desistida
// (o operador fechou a tela, a geracao de legendas morreu junto com o processo,
// etc). Sem este teto, o sweep - que e re-registrado a cada start dos workers -
// reconfirmava essas campanhas antigas a cada `docker compose up` e disparava a
// campanha inteira para todos os grupos, o que na pratica virou spam.
const DEFAULT_MAX_AUTO_CONFIRM_AGE_MS = 24 * 60 * 60 * 1000;

function resolveMaxAutoConfirmAgeMs() {
  const configured = Number(process.env.MAX_AUTO_CONFIRM_AGE_MS);

  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_MAX_AUTO_CONFIRM_AGE_MS;
  }

  return Math.trunc(configured);
}

function resolveCampaignStatusChangedAt(campaign) {
  return (campaign && (campaign.status_changed_at || campaign.updated_at || campaign.created_at)) || null;
}

let dispatchReviewTimeoutQueueInstance;

function getDispatchReviewTimeoutQueue() {
  if (!dispatchReviewTimeoutQueueInstance) {
    dispatchReviewTimeoutQueueInstance = createQueue(queueNames.dispatchReviewTimeout);
  }

  return dispatchReviewTimeoutQueueInstance;
}

async function scheduleDispatchReviewTimeoutSweep(options = {}) {
  const everyMs = Number(options.every_ms || options.everyMs || DEFAULT_SWEEP_EVERY_MS);

  return getDispatchReviewTimeoutQueue().add(
    DISPATCH_REVIEW_TIMEOUT_JOB_NAME,
    {},
    {
      repeat: {
        key: DISPATCH_REVIEW_TIMEOUT_SCHEDULE_KEY,
        every: everyMs,
      },
      removeOnComplete: true,
      removeOnFail: true,
    }
  );
}

// Varre campanhas presas em "gerando_legendas" (aguardando revisao humana) ha
// mais tempo que o configurado em dispatch_rules.auto_send_after_timeout.minutes,
// e confirma o dispatch automaticamente por elas - reaproveita 100% a logica de
// confirmDispatch, o mesmo caminho usado quando um humano clica "Iniciar envio".
function createDispatchReviewTimeoutProcessor(options = {}) {
  const {
    campaignsRepository = defaultCampaignsRepository,
    settingsService = defaultSettingsService,
    campaignsService = defaultCampaignsService,
    now = () => new Date(),
    logger = console,
  } = options;

  return async function dispatchReviewTimeoutWorker() {
    const dispatchRules = await settingsService.getDispatchRulesSettings();
    const timeoutConfig = dispatchRules.auto_send_after_timeout || {};

    if (!timeoutConfig.enabled) {
      return { checked: 0, confirmed: 0 };
    }

    const minutes = Number(timeoutConfig.minutes) || 60;
    const nowMs = now().getTime();
    const cutoffDate = new Date(nowMs - minutes * 60 * 1000);
    const staleCampaigns = await campaignsRepository.listByStatusOlderThan(
      CAMPAIGN_STATUS_GENERATING_CAPTIONS,
      cutoffDate
    );
    const maxAgeMs = resolveMaxAutoConfirmAgeMs();

    let confirmed = 0;
    let skippedTooOld = 0;

    for (const campaign of staleCampaigns) {
      // Teto de idade: confirmar automaticamente uma campanha abandonada ha dias
      // significa montar uma janela NOVA (confirmDispatch reagenda para
      // "agora + alguns minutos") e disparar para todos os grupos. Como a
      // campanha antiga nunca sai de "gerando_legendas" sozinha, isso se repetia
      // a cada boot dos workers. Retomar uma campanha nesse estado e decisao do
      // operador, nao de um sweep automatico.
      const statusChangedAt = resolveCampaignStatusChangedAt(campaign);
      const ageMs = statusChangedAt ? nowMs - new Date(statusChangedAt).getTime() : null;

      if (!Number.isFinite(ageMs) || ageMs > maxAgeMs) {
        skippedTooOld += 1;

        logger.warn &&
          logger.warn(
            JSON.stringify({
              event: "dispatch_review_timeout.skipped_too_old",
              campaign_id: campaign.id,
              status_changed_at: statusChangedAt,
              idade_h: Number.isFinite(ageMs) ? Math.floor(ageMs / 3600000) : "desconhecida",
              max_idade_h: Math.floor(maxAgeMs / 3600000),
              note: "campanha abandonada exige confirmacao manual; auto-confirmar aqui reenviava tudo a cada boot",
            })
          );

        continue;
      }

      try {
        await campaignsService.confirmDispatch(campaign.id, {});
        confirmed += 1;

        logger.info &&
          logger.info(
            JSON.stringify({
              event: "dispatch_review_timeout.confirmed",
              campaign_id: campaign.id,
            })
          );
      } catch (error) {
        logger.error &&
          logger.error(
            JSON.stringify({
              event: "dispatch_review_timeout.confirm_failed",
              campaign_id: campaign.id,
              error_message: error.message,
            })
          );
      }
    }

    return { checked: staleCampaigns.length, confirmed, skipped_too_old: skippedTooOld };
  };
}

function createDispatchReviewTimeoutWorker(options = {}) {
  return createWorker(queueNames.dispatchReviewTimeout, createDispatchReviewTimeoutProcessor(options), options);
}

function createDispatchReviewTimeoutEvents(options = {}) {
  return createQueueEvents(queueNames.dispatchReviewTimeout, options);
}

module.exports = {
  DEFAULT_MAX_AUTO_CONFIRM_AGE_MS,
  DISPATCH_REVIEW_TIMEOUT_JOB_NAME,
  DISPATCH_REVIEW_TIMEOUT_SCHEDULE_KEY,
  resolveMaxAutoConfirmAgeMs,
  createDispatchReviewTimeoutProcessor,
  createDispatchReviewTimeoutWorker,
  createDispatchReviewTimeoutEvents,
  scheduleDispatchReviewTimeoutSweep,
  get dispatchReviewTimeoutQueue() {
    return getDispatchReviewTimeoutQueue();
  },
};
