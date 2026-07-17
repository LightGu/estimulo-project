const groupsService = require("../services/groups.service");
const { createQueue, createQueueEvents, createWorker } = require("./bullmq");
const {
  GROUP_SYNC_SCHEDULE_KEY,
  buildGroupSyncRepeatOptions,
  buildGroupSyncScheduleJobData: buildScheduleJobData,
} = require("./group-sync-schedule");
const { queueNames } = require("./names");

const GROUP_SYNC_JOB_NAME = "sync-groups-from-evolution";
const GROUP_SYNC_INITIAL_STATUS = "pending";
const GROUP_SYNC_PROCESSING_STATUS = "processing";
const GROUP_SYNC_SUCCESS_STATUS = "completed";
const GROUP_SYNC_FAILED_STATUS = "failed";

let groupSyncQueueInstance;

function getGroupSyncQueue() {
  if (!groupSyncQueueInstance) {
    groupSyncQueueInstance = createQueue(queueNames.groupSync);
  }

  return groupSyncQueueInstance;
}

function buildGroupSyncJobData(params = {}) {
  const organizationId = params.organization_id || params.organizationId || process.env.GROUP_SYNC_ORGANIZATION_ID;
  const maturidade = Number(params.maturidade || params.defaultMaturidade || process.env.GROUP_SYNC_DEFAULT_MATURIDADE || 1);

  if (!organizationId) {
    throw new Error("organization_id ou GROUP_SYNC_ORGANIZATION_ID e obrigatorio para sincronizar grupos");
  }

  if (!Number.isInteger(maturidade) || maturidade < 1 || maturidade > 4) {
    throw new Error("GROUP_SYNC_DEFAULT_MATURIDADE deve ser um inteiro entre 1 e 4");
  }

  return {
    organization_id: organizationId,
    maturidade,
    status: params.status || GROUP_SYNC_INITIAL_STATUS,
    requested_at: (params.requested_at ? new Date(params.requested_at) : new Date()).toISOString(),
  };
}

async function addGroupSyncJob(params = {}, options = {}) {
  const jobData = buildGroupSyncJobData(params);

  return getGroupSyncQueue().add(GROUP_SYNC_JOB_NAME, jobData, options);
}

function buildGroupSyncScheduleJobData(params = {}, repeatOptions) {
  return buildScheduleJobData(params, repeatOptions, buildGroupSyncJobData);
}

async function scheduleGroupSyncJob(params = {}, options = {}) {
  const repeatOptions = buildGroupSyncRepeatOptions(params);
  const jobData = buildGroupSyncScheduleJobData(params, repeatOptions);
  const { repeat: _ignoredRepeatOptions, ...jobOptionOverrides } = options;

  return getGroupSyncQueue().add(GROUP_SYNC_JOB_NAME, jobData, {
    ...jobOptionOverrides,
    repeat: repeatOptions,
  });
}

function createGroupSyncProcessor(options = {}) {
  const { service = groupsService, logger = console } = options;

  return async function groupSyncWorker(job) {
    const startedAt = new Date().toISOString();

    await job.updateData({
      ...job.data,
      status: GROUP_SYNC_PROCESSING_STATUS,
      started_at: startedAt,
    });

    try {
      logger.info &&
        logger.info(
          JSON.stringify({
            event: "group_sync.started",
            job_id: job.id,
            organization_id: job.data.organization_id,
            schedule_key: job.data.schedule_key,
          })
        );

      const result = await service.syncGroupsFromEvolution({
        organization_id: job.data.organization_id,
        maturidade: job.data.maturidade,
      });
      const completedAt = new Date().toISOString();

      await job.updateData({
        ...job.data,
        status: GROUP_SYNC_SUCCESS_STATUS,
        started_at: startedAt,
        completed_at: completedAt,
        inserted: result.inserted,
        updated: result.updated,
        ignored: result.ignored,
      });

      logger.info &&
        logger.info(
          JSON.stringify({
            event: "group_sync.completed",
            job_id: job.id,
            organization_id: job.data.organization_id,
            inserted: result.inserted,
            updated: result.updated,
            ignored: result.ignored,
          })
        );

      return {
        status: GROUP_SYNC_SUCCESS_STATUS,
        started_at: startedAt,
        completed_at: completedAt,
        ...result,
      };
    } catch (error) {
      const failedAt = new Date().toISOString();

      await job.updateData({
        ...job.data,
        status: GROUP_SYNC_FAILED_STATUS,
        started_at: startedAt,
        failed_at: failedAt,
        error_message: error.message,
      });

      logger.error &&
        logger.error(
          JSON.stringify({
            event: "group_sync.failed",
            job_id: job.id,
            organization_id: job.data.organization_id,
            error_message: error.message,
          })
        );

      throw error;
    }
  };
}

function createGroupSyncWorker(options = {}) {
  const { service, logger, ...workerOptions } = options;

  return createWorker(queueNames.groupSync, createGroupSyncProcessor({ service, logger }), workerOptions);
}

function createGroupSyncEvents(options = {}) {
  return createQueueEvents(queueNames.groupSync, options);
}

module.exports = {
  GROUP_SYNC_FAILED_STATUS,
  GROUP_SYNC_INITIAL_STATUS,
  GROUP_SYNC_JOB_NAME,
  GROUP_SYNC_PROCESSING_STATUS,
  GROUP_SYNC_SCHEDULE_KEY,
  GROUP_SYNC_SUCCESS_STATUS,
  addGroupSyncJob,
  buildGroupSyncJobData,
  buildGroupSyncRepeatOptions,
  buildGroupSyncScheduleJobData,
  createGroupSyncEvents,
  createGroupSyncProcessor,
  createGroupSyncWorker,
  get groupSyncQueue() {
    return getGroupSyncQueue();
  },
  scheduleGroupSyncJob,
};
