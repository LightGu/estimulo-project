const { createQueue, createQueueEvents, createWorker } = require("./bullmq");
const { queueNames } = require("./names");
const { buildJitteredDispatchSchedule } = require("./dispatch-jitter");
const { sendToEvolution } = require("../services/evolution");

const DISPATCH_JOB_NAME = "dispatch-content";
const DISPATCH_INITIAL_STATUS = "pending";
const DISPATCH_SUCCESS_STATUS = "sent";
const DISPATCH_FAILED_STATUS = "failed";

const dispatchQueue = createQueue(queueNames.dispatch, {
  defaultJobOptions: {
    attempts: 1,
  },
});

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
  assertRequiredField(params, "link_video");
  assertRequiredField(params, "legenda");

  const scheduledDate = normalizeScheduledDate(params.scheduled_at || params.scheduledAt);

  return {
    group_id: params.group_id,
    campaign_id: params.campaign_id,
    link_video: params.link_video,
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

function buildDispatchDeliveryPayload(jobData) {
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

async function addDispatchJob(params, options = {}) {
  const jobData = buildDispatchJobData(params);
  const jobOptions = buildDispatchJobOptions(jobData, options);

  return dispatchQueue.add(DISPATCH_JOB_NAME, jobData, jobOptions);
}

async function addJitteredDispatchJobs(params, options = {}) {
  const schedule = buildJitteredDispatchSchedule(params);
  const jobs = [];

  for (const jobData of schedule) {
    jobs.push(await addDispatchJob(jobData, options));
  }

  return jobs;
}

function createDispatchWorker(options = {}) {
  const { sender = sendToEvolution, ...workerOptions } = options;

  return createWorker(
    queueNames.dispatch,
    async (job) => {
      try {
        const delivery = await sender(buildDispatchDeliveryPayload(job.data));
        const completedAt = new Date().toISOString();

        await job.updateData({
          ...job.data,
          status: DISPATCH_SUCCESS_STATUS,
          completed_at: completedAt,
        });

        console.info(
          JSON.stringify({
            event: "dispatch.sent",
            job_id: job.id,
            campaign_id: job.data.campaign_id,
            group_id: job.data.group_id,
            completed_at: completedAt,
          })
        );

        return {
          status: DISPATCH_SUCCESS_STATUS,
          delivery,
          completed_at: completedAt,
        };
      } catch (error) {
        const failedAt = new Date().toISOString();

        await job.updateData({
          ...job.data,
          status: DISPATCH_FAILED_STATUS,
          failed_at: failedAt,
          error_message: error.message,
        });

        console.error(
          JSON.stringify({
            event: "dispatch.failed",
            job_id: job.id,
            campaign_id: job.data.campaign_id,
            group_id: job.data.group_id,
            failed_at: failedAt,
            error_message: error.message,
          })
        );

        throw error;
      }
    },
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
  DISPATCH_SUCCESS_STATUS,
  addDispatchJob,
  addJitteredDispatchJobs,
  buildDispatchDeliveryPayload,
  buildDispatchJobData,
  buildJitteredDispatchSchedule,
  createDispatchEvents,
  createDispatchWorker,
  dispatchQueue,
};
