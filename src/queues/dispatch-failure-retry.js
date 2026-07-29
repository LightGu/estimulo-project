const { createQueue, createQueueEvents, createWorker } = require("./bullmq");
const { queueNames } = require("./names");
const { addDispatchJob } = require("./dispatch");
const defaultDispatchLogsRepository = require("../repositories/dispatch-logs.repository");
const defaultGroupsRepository = require("../repositories/groups.repository");
const defaultSettingsService = require("../services/settings.service");

const DISPATCH_FAILURE_RETRY_JOB_NAME = "dispatch-failure-retry-sweep";
const DISPATCH_FAILURE_RETRY_SCHEDULE_KEY = "dispatch-failure-retry-sweep";
const DEFAULT_SWEEP_EVERY_MS = 5 * 60 * 1000;
const MAX_RETRY_ATTEMPTS = 3;
const FAILED_STATUS = "falhou";

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
    settingsService = defaultSettingsService,
    enqueueDispatch = addDispatchJob,
    logger = console,
  } = options;

  return async function dispatchFailureRetryWorker() {
    const dispatchRules = await settingsService.getDispatchRulesSettings();

    if (!dispatchRules.auto_retry_failures) {
      return { checked: 0, retried: 0 };
    }

    const failedLogs = await dispatchLogsRepository.listFailedForRetry();
    const retryableLogs = failedLogs.filter((log) => (log.retry_count || 0) < MAX_RETRY_ATTEMPTS);

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
          { ...buildRetryJobData({ ...log, groups: group }) },
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

    return { checked: retryableLogs.length, retried };
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
  MAX_RETRY_ATTEMPTS,
  buildRetryJobData,
  createDispatchFailureRetryProcessor,
  createDispatchFailureRetryWorker,
  createDispatchFailureRetryEvents,
  scheduleDispatchFailureRetrySweep,
  get dispatchFailureRetryQueue() {
    return getDispatchFailureRetryQueue();
  },
};
