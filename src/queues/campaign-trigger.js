const { createQueue, createQueueEvents, createWorker } = require("./bullmq");
const { queueNames } = require("./names");

const CAMPAIGN_TRIGGER_JOB_NAME = "trigger-campaign";
const CAMPAIGN_TRIGGER_INITIAL_STATUS = "pending";
const CAMPAIGN_TRIGGER_ACTIVE_STATUS = "active";
const CAMPAIGN_TRIGGER_INACTIVE_STATUS = "inactive";
const CAMPAIGN_TRIGGER_TYPE_RECURRING = "recurring";

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
  const timeWindow = normalizeTimeWindow(params);
  const dispatchJitter = normalizeDispatchJitter(params);

  return {
    campaign_id: params.campaign_id,
    execution_at: executionDate.toISOString(),
    time_window: timeWindow,
    dispatch_jitter: dispatchJitter,
    status: params.status || CAMPAIGN_TRIGGER_INITIAL_STATUS,
  };
}

function assertCampaignId(params) {
  if (!params || !params.campaign_id) {
    throw new Error("campaign_id e obrigatorio para agendar campaign-trigger");
  }
}

function buildCampaignScheduleKey(campaignId) {
  return `campaign-trigger:${campaignId}`;
}

function normalizeBooleanStatus(params = {}) {
  if (params.active !== undefined) {
    if (typeof params.active === "boolean") {
      return params.active;
    }

    const activeValue = String(params.active).toLowerCase();

    return !["false", "0", "inactive", "inativo", "disabled", "paused"].includes(activeValue);
  }

  const rawStatus = String(params.status || CAMPAIGN_TRIGGER_ACTIVE_STATUS).toLowerCase();
  const inactiveStatuses = new Set([
    "inactive",
    "inativo",
    "inativa",
    "disabled",
    "paused",
    "cancelled",
    "canceled",
  ]);

  return !inactiveStatuses.has(rawStatus);
}

function normalizeDateField(value, fieldName) {
  if (!value) {
    return undefined;
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} deve ser uma data valida`);
  }

  return date;
}

function normalizeTimeWindow(params = {}) {
  const timeWindow = params.time_window || params.timeWindow || {};
  const start = params.window_start || params.windowStart || timeWindow.start || timeWindow.start_at;
  const end = params.window_end || params.windowEnd || timeWindow.end || timeWindow.end_at;

  if (!start && !end) {
    return undefined;
  }

  if (!start || !end) {
    throw new Error("window_start e window_end devem ser informados juntos");
  }

  return {
    start,
    end,
    timezone: params.timezone || timeWindow.timezone || params.tz,
  };
}

function normalizeDispatchJitter(params = {}) {
  const jitter = params.dispatch_jitter || params.dispatchJitter || params.jitter || {};
  const minDelay =
    params.jitter_delay_min_ms ??
    params.jitterDelayMinMs ??
    params.min_delay_ms ??
    params.minDelayMs ??
    jitter.min_ms ??
    jitter.minDelayMs;
  const maxDelay =
    params.jitter_delay_max_ms ??
    params.jitterDelayMaxMs ??
    params.max_delay_ms ??
    params.maxDelayMs ??
    jitter.max_ms ??
    jitter.maxDelayMs;

  if (minDelay === undefined && maxDelay === undefined) {
    return undefined;
  }

  if (minDelay === undefined || maxDelay === undefined) {
    throw new Error("jitter_delay_min_ms e jitter_delay_max_ms devem ser informados juntos");
  }

  const minMs = Math.trunc(Number(minDelay));
  const maxMs = Math.trunc(Number(maxDelay));

  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) {
    throw new Error("jitter_delay_min_ms e jitter_delay_max_ms devem ser numeros validos");
  }

  if (minMs < 0 || maxMs < 0) {
    throw new Error("jitter_delay_min_ms e jitter_delay_max_ms devem ser maiores ou iguais a zero");
  }

  if (maxMs < minMs) {
    throw new Error("jitter_delay_max_ms deve ser maior ou igual a jitter_delay_min_ms");
  }

  return {
    min_ms: minMs,
    max_ms: maxMs,
  };
}

function normalizeRepeatOptions(params = {}) {
  const recurrenceRule = params.recurrence_rule || params.recurrenceRule || params.repeat || {};
  const pattern =
    params.cron_expression ||
    params.cronExpression ||
    recurrenceRule.cron_expression ||
    recurrenceRule.cronExpression ||
    recurrenceRule.pattern;
  const every = params.every || recurrenceRule.every;

  if (pattern && every) {
    throw new Error("Informe cron_expression ou every, nao ambos");
  }

  if (!pattern && !every) {
    throw new Error("cron_expression, recurrence_rule.pattern ou recurrence_rule.every e obrigatorio");
  }

  const repeatOptions = {
    key: buildCampaignScheduleKey(params.campaign_id),
  };

  if (pattern) {
    repeatOptions.pattern = pattern;
  }

  if (every) {
    repeatOptions.every = Number(every);

    if (!Number.isFinite(repeatOptions.every) || repeatOptions.every <= 0) {
      throw new Error("recurrence_rule.every deve ser um numero positivo em milissegundos");
    }
  }

  const startDate = normalizeDateField(params.start_date || params.startDate || recurrenceRule.startDate, "start_date");
  const endDate = normalizeDateField(params.end_date || params.endDate || recurrenceRule.endDate, "end_date");

  if (startDate) {
    repeatOptions.startDate = startDate;
  }

  if (endDate) {
    repeatOptions.endDate = endDate;
  }

  if (params.timezone || params.tz || recurrenceRule.tz) {
    repeatOptions.tz = params.timezone || params.tz || recurrenceRule.tz;
  }

  if (params.limit || recurrenceRule.limit) {
    repeatOptions.limit = Number(params.limit || recurrenceRule.limit);

    if (!Number.isInteger(repeatOptions.limit) || repeatOptions.limit <= 0) {
      throw new Error("recurrence_rule.limit deve ser um inteiro positivo");
    }
  }

  if (params.immediately !== undefined || recurrenceRule.immediately !== undefined) {
    repeatOptions.immediately = Boolean(params.immediately ?? recurrenceRule.immediately);
  }

  return repeatOptions;
}

function buildCampaignScheduleJobData(params, repeatOptions) {
  const active = normalizeBooleanStatus(params);
  const timeWindow = normalizeTimeWindow(params);
  const dispatchJitter = normalizeDispatchJitter(params);
  const now = new Date().toISOString();

  return {
    campaign_id: params.campaign_id,
    schedule_key: repeatOptions.key,
    trigger_type: CAMPAIGN_TRIGGER_TYPE_RECURRING,
    recurrence: {
      pattern: repeatOptions.pattern,
      every: repeatOptions.every,
      start_date: repeatOptions.startDate ? repeatOptions.startDate.toISOString() : undefined,
      end_date: repeatOptions.endDate ? repeatOptions.endDate.toISOString() : undefined,
      timezone: repeatOptions.tz,
      limit: repeatOptions.limit,
    },
    time_window: timeWindow,
    dispatch_jitter: dispatchJitter,
    active,
    status: active ? CAMPAIGN_TRIGGER_ACTIVE_STATUS : CAMPAIGN_TRIGGER_INACTIVE_STATUS,
    dispatch_queue: queueNames.dispatch,
    created_at: now,
    updated_at: now,
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

async function removeCampaignSchedule(params) {
  const campaignId = typeof params === "string" ? params : params && params.campaign_id;

  if (!campaignId) {
    throw new Error("campaign_id e obrigatorio para remover agendamento de campanha");
  }

  const scheduleKey = buildCampaignScheduleKey(campaignId);
  const removed = await campaignTriggerQueue.removeRepeatableByKey(scheduleKey);

  return {
    campaign_id: campaignId,
    schedule_key: scheduleKey,
    removed,
  };
}

async function disableCampaignSchedule(params) {
  return removeCampaignSchedule(params);
}

async function scheduleCampaign(params, options = {}) {
  assertCampaignId(params);

  const active = normalizeBooleanStatus(params);

  if (!active) {
    return disableCampaignSchedule(params);
  }

  const repeatOptions = normalizeRepeatOptions(params);
  const jobData = buildCampaignScheduleJobData(params, repeatOptions);
  const { repeat: _ignoredRepeatOptions, ...jobOptionOverrides } = options;
  const jobOptions = {
    ...jobOptionOverrides,
    repeat: repeatOptions,
  };

  return campaignTriggerQueue.add(CAMPAIGN_TRIGGER_JOB_NAME, jobData, jobOptions);
}

function createCampaignTriggerWorker(processor, options = {}) {
  return createWorker(queueNames.campaignTrigger, processor, options);
}

function createCampaignTriggerEvents(options = {}) {
  return createQueueEvents(queueNames.campaignTrigger, options);
}

module.exports = {
  CAMPAIGN_TRIGGER_ACTIVE_STATUS,
  CAMPAIGN_TRIGGER_INITIAL_STATUS,
  CAMPAIGN_TRIGGER_INACTIVE_STATUS,
  CAMPAIGN_TRIGGER_JOB_NAME,
  CAMPAIGN_TRIGGER_TYPE_RECURRING,
  addCampaignTriggerJob,
  buildCampaignScheduleJobData,
  buildCampaignScheduleKey,
  buildCampaignTriggerJobData,
  campaignTriggerQueue,
  createCampaignTriggerEvents,
  createCampaignTriggerWorker,
  disableCampaignSchedule,
  removeCampaignSchedule,
  scheduleCampaign,
};
