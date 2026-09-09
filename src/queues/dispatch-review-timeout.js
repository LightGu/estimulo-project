const { createQueue, createQueueEvents, createWorker } = require("./bullmq");
const { queueNames } = require("./names");
const defaultCampaignsRepository = require("../repositories/campaigns.repository");
const defaultSettingsService = require("../services/settings.service");
const defaultCampaignsService = require("../services/campaigns.service");
const defaultInAppNotificationsService = require("../services/in-app-notifications.service");

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

// Quanto tempo em "gerando_legendas" antes de tratar a campanha como travada.
//
// Folgado de proposito: a geracao legitimamente leva minutos numa campanha com
// muitos grupos (uma chamada de IA por par grupo/video), e alertar cedo demais
// treinaria o operador a ignorar o aviso.
const DEFAULT_STUCK_ALERT_AFTER_MS = 30 * 60 * 1000;

function resolveStuckAlertAfterMs() {
  const configured = Number(process.env.CAMPAIGN_STUCK_ALERT_AFTER_MS);

  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_STUCK_ALERT_AFTER_MS;
  }

  return Math.trunc(configured);
}

// Campanhas ja avisadas nesta vida do processo.
//
// O sweep roda a cada 60s; sem dedupe, uma campanha travada geraria uma
// notificacao por minuto e afogaria o painel - o oposto do objetivo. LIMITACAO
// ACEITA: um restart do worker esvazia o conjunto e a campanha ainda travada e'
// avisada mais uma vez. Restart e' evento de deploy, entao o custo e' um aviso
// repetido por deploy; o alternativo seria uma coluna nova so para isso, e
// silenciar de vez e' pior do que repetir.
const alertedStuckCampaigns = new Set();

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
    inAppNotificationsService = defaultInAppNotificationsService,
    now = () => new Date(),
    logger = console,
  } = options;

  return async function dispatchReviewTimeoutWorker() {
    const dispatchRules = await settingsService.getDispatchRulesSettings();
    const timeoutConfig = dispatchRules.auto_send_after_timeout || {};
    const nowMs = now().getTime();
    const maxAgeMs = resolveMaxAutoConfirmAgeMs();

    // DETECCAO, sempre - independente de auto_send_after_timeout.
    //
    // Antes a funcao inteira saia aqui com `return` quando a confirmacao
    // automatica estava desligada, que e' o DEFAULT
    // (auto_send_after_timeout.enabled = false). Consequencia: na configuracao
    // padrao, uma campanha presa em "gerando_legendas" era completamente
    // invisivel. E ficar presa e' um estado alcancavel de verdade - a geracao de
    // legendas roda como promise solta no processo da API, entao um deploy no
    // meio dela mata o trabalho sem deixar de onde retomar.
    //
    // Detectar e avisar nao e a mesma coisa que retomar: retomar sozinha uma
    // campanha abandonada monta uma janela nova e dispara para todos os grupos,
    // que e' justamente o que gerava spam a cada boot. A decisao segue do
    // operador; o que muda e' que ele passa a saber que precisa toma-la.
    const stuckCampaigns = await campaignsRepository.listByStatusOlderThan(
      CAMPAIGN_STATUS_GENERATING_CAPTIONS,
      new Date(nowMs - resolveStuckAlertAfterMs())
    );

    let alerted = 0;

    for (const campaign of stuckCampaigns) {
      if (alertedStuckCampaigns.has(campaign.id)) {
        continue;
      }

      const statusChangedAt = resolveCampaignStatusChangedAt(campaign);
      const ageMs = statusChangedAt ? nowMs - new Date(statusChangedAt).getTime() : null;

      alertedStuckCampaigns.add(campaign.id);
      alerted += 1;

      logger.warn &&
        logger.warn(
          JSON.stringify({
            event: "dispatch_review_timeout.campaign_stuck",
            campaign_id: campaign.id,
            status_changed_at: statusChangedAt,
            idade_h: Number.isFinite(ageMs) ? Math.floor(ageMs / 3600000) : "desconhecida",
            note: "campanha presa em gerando_legendas; a geracao nao sera retomada sozinha",
          })
        );

      if (inAppNotificationsService && typeof inAppNotificationsService.notifyCampaignStuckGeneratingCaptions === "function") {
        await inAppNotificationsService
          .notifyCampaignStuckGeneratingCaptions({
            campaignId: campaign.id,
            campaignLabel: campaign.trilha || campaign.titulo,
            ageHours: Number.isFinite(ageMs) ? Math.floor(ageMs / 3600000) : undefined,
          })
          .catch((error) => {
            // Falhar aqui nao pode derrubar o sweep; mas tira o id do conjunto
            // para a proxima passada tentar de novo, senao o alerta seria
            // perdido de vez.
            alertedStuckCampaigns.delete(campaign.id);
            logger.error &&
              logger.error(
                JSON.stringify({
                  event: "dispatch_review_timeout.stuck_alert_failed",
                  campaign_id: campaign.id,
                  error_message: error && error.message,
                })
              );
          });
      }
    }

    // CONFIRMACAO AUTOMATICA, so quando configurada.
    if (!timeoutConfig.enabled) {
      return { checked: 0, confirmed: 0, stuck_alerted: alerted };
    }

    const minutes = Number(timeoutConfig.minutes) || 60;
    const cutoffDate = new Date(nowMs - minutes * 60 * 1000);
    const staleCampaigns = await campaignsRepository.listByStatusOlderThan(
      CAMPAIGN_STATUS_GENERATING_CAPTIONS,
      cutoffDate
    );

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
  DEFAULT_STUCK_ALERT_AFTER_MS,
  resolveStuckAlertAfterMs,
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
