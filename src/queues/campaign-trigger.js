const { createQueue, createQueueEvents, createWorker } = require("./bullmq");
const { queueNames } = require("./names");

const CAMPAIGN_TRIGGER_JOB_NAME = "trigger-campaign";
const CAMPAIGN_TRIGGER_INITIAL_STATUS = "pending";

const campaignTriggerQueue = createQueue(queueNames.campaignTrigger);

function normalizeExecutionDate(executionAt = new Date()) {
  const date = executionAt instanceof Date ? executionAt : new Date(executionAt);

  if (Number.isNaN(date.getTime())) {
    throw new Error("execution_at deve ser uma data valida");
  }

  return date;
}

function buildCampaignTriggerJobData(params) {
  if (!params || !params.campaign_id) {
    throw new Error("campaign_id e obrigatorio para enfileirar campaign-trigger");
  }

  const executionDate = normalizeExecutionDate(params.execution_at || params.executionAt);

  return {
    campaign_id: params.campaign_id,
    execution_at: executionDate.toISOString(),
    status: params.status || CAMPAIGN_TRIGGER_INITIAL_STATUS,
  };
}

function buildCampaignTriggerJobOptions(jobData, options = {}) {
  const executionTime = new Date(jobData.execution_at).getTime();
  const delay = Math.max(executionTime - Date.now(), 0);

  return {
    ...options,
    delay: options.delay ?? delay,
  };
}

async function addCampaignTriggerJob(params, options = {}) {
  const jobData = buildCampaignTriggerJobData(params);
  const jobOptions = buildCampaignTriggerJobOptions(jobData, options);

  return campaignTriggerQueue.add(CAMPAIGN_TRIGGER_JOB_NAME, jobData, jobOptions);
}

function createCampaignTriggerWorker(processor, options = {}) {
  return createWorker(queueNames.campaignTrigger, processor, options);
}

function createCampaignTriggerEvents(options = {}) {
  return createQueueEvents(queueNames.campaignTrigger, options);
}

module.exports = {
  CAMPAIGN_TRIGGER_INITIAL_STATUS,
  CAMPAIGN_TRIGGER_JOB_NAME,
  addCampaignTriggerJob,
  buildCampaignTriggerJobData,
  campaignTriggerQueue,
  createCampaignTriggerEvents,
  createCampaignTriggerWorker,
};
