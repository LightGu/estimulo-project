const { createQueue, createQueueEvents, createWorker } = require("./bullmq");
const { queueNames } = require("./names");
const defaultCampaignsRepository = require("../repositories/campaigns.repository");
const defaultSettingsService = require("../services/settings.service");
const defaultCampaignsService = require("../services/campaigns.service");

const DISPATCH_REVIEW_TIMEOUT_JOB_NAME = "dispatch-review-timeout-sweep";
const DISPATCH_REVIEW_TIMEOUT_SCHEDULE_KEY = "dispatch-review-timeout-sweep";
const DEFAULT_SWEEP_EVERY_MS = 60 * 1000;
const CAMPAIGN_STATUS_GENERATING_CAPTIONS = "gerando_legendas";

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
    logger = console,
  } = options;

  return async function dispatchReviewTimeoutWorker() {
    const dispatchRules = await settingsService.getDispatchRulesSettings();
    const timeoutConfig = dispatchRules.auto_send_after_timeout || {};

    if (!timeoutConfig.enabled) {
      return { checked: 0, confirmed: 0 };
    }

    const minutes = Number(timeoutConfig.minutes) || 60;
    const cutoffDate = new Date(Date.now() - minutes * 60 * 1000);
    const staleCampaigns = await campaignsRepository.listByStatusOlderThan(
      CAMPAIGN_STATUS_GENERATING_CAPTIONS,
      cutoffDate
    );

    let confirmed = 0;

    for (const campaign of staleCampaigns) {
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

    return { checked: staleCampaigns.length, confirmed };
  };
}

function createDispatchReviewTimeoutWorker(options = {}) {
  return createWorker(queueNames.dispatchReviewTimeout, createDispatchReviewTimeoutProcessor(options), options);
}

function createDispatchReviewTimeoutEvents(options = {}) {
  return createQueueEvents(queueNames.dispatchReviewTimeout, options);
}

module.exports = {
  DISPATCH_REVIEW_TIMEOUT_JOB_NAME,
  DISPATCH_REVIEW_TIMEOUT_SCHEDULE_KEY,
  createDispatchReviewTimeoutProcessor,
  createDispatchReviewTimeoutWorker,
  createDispatchReviewTimeoutEvents,
  scheduleDispatchReviewTimeoutSweep,
  get dispatchReviewTimeoutQueue() {
    return getDispatchReviewTimeoutQueue();
  },
};
