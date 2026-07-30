const { createQueue, createQueueEvents, createWorker } = require("./bullmq");
const { queueNames } = require("./names");
const { buildJitteredDispatchSchedule } = require("./dispatch-jitter");
const { sendToEvolution } = require("../services/evolution");
const dispatchLogsRepository = require("../repositories/dispatch-logs.repository");

const MENSAGENS_DISPATCH_JOB_NAME = "mensagens-dispatch";
const MENSAGENS_DISPATCH_INITIAL_STATUS = "pending";
const MENSAGENS_DISPATCH_PROCESSING_STATUS = "processing";
const MENSAGENS_DISPATCH_SUCCESS_STATUS = "sent";
const MENSAGENS_DISPATCH_FAILED_STATUS = "failed";
const DEFAULT_MENSAGENS_DISPATCH_JOB_TIMEOUT_MS = 60 * 1000;

let mensagensDispatchQueueInstance;

function resolveMensagensDispatchJobTimeoutMs() {
  const timeoutMs = Number(process.env.MENSAGENS_DISPATCH_JOB_TIMEOUT_MS || DEFAULT_MENSAGENS_DISPATCH_JOB_TIMEOUT_MS);

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_MENSAGENS_DISPATCH_JOB_TIMEOUT_MS;
  }

  return Math.trunc(timeoutMs);
}

function getMensagensDispatchQueue() {
  if (!mensagensDispatchQueueInstance) {
    mensagensDispatchQueueInstance = createQueue(queueNames.mensagensDispatch, {
      defaultJobOptions: {
        attempts: 1,
        timeout: resolveMensagensDispatchJobTimeoutMs(),
      },
    });
  }

  return mensagensDispatchQueueInstance;
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
    throw new Error(`${fieldName} e obrigatorio para enfileirar mensagens-dispatch`);
  }
}

function buildMensagensJobData(params = {}) {
  assertRequiredField(params, "group_id");

  if (!params.message && !params.content) {
    throw new Error("message ou content e obrigatorio para enfileirar mensagens-dispatch");
  }

  const scheduledDate = normalizeScheduledDate(params.scheduled_at || params.scheduledAt);

  return {
    group_id: params.group_id,
    internal_group_id: params.internal_group_id || params.internalGroupId,
    group_nome: params.group_nome || params.groupNome,
    message: params.message || "",
    content: params.content || null,
    scheduled_at: scheduledDate.toISOString(),
    status: params.status || MENSAGENS_DISPATCH_INITIAL_STATUS,
    dispatch_order: params.dispatch_order,
    jitter_delay_ms: params.jitter_delay_ms,
    cumulative_delay_ms: params.cumulative_delay_ms,
    dispatch_log_id: params.dispatch_log_id || null,
  };
}

function buildMensagensJobOptions(jobData, options = {}) {
  const scheduledTime = new Date(jobData.scheduled_at).getTime();
  const delay = Math.max(scheduledTime - Date.now(), 0);

  return {
    ...options,
    delay: options.delay ?? delay,
  };
}

async function addMensagensDispatchJob(params, options = {}) {
  const jobData = buildMensagensJobData(params);
  const jobOptions = buildMensagensJobOptions(jobData, options);

  return getMensagensDispatchQueue().add(MENSAGENS_DISPATCH_JOB_NAME, jobData, jobOptions);
}

async function addJitteredMensagensDispatchJobs(params, options = {}) {
  const schedule = buildJitteredDispatchSchedule(params);
  const jobs = [];

  for (const jobData of schedule) {
    jobs.push(await addMensagensDispatchJob(jobData, options));
  }

  return jobs;
}

function createMensagensDispatchProcessor(options = {}) {
  const { sender = sendToEvolution, logger = console, dispatchLogs = dispatchLogsRepository } = options;

  async function updateDispatchLogStatus(dispatchLogId, status, mensagemErro) {
    if (!dispatchLogId) {
      return;
    }

    try {
      await dispatchLogs.updateStatus(dispatchLogId, status, mensagemErro || null);
    } catch (error) {
      logger.error &&
        logger.error(
          JSON.stringify({
            event: "mensagens_dispatch.update_log_failed",
            dispatch_log_id: dispatchLogId,
            status,
            error_message: error?.message,
          })
        );
    }
  }

  return async function mensagensDispatchWorker(job) {
    const startedAt = new Date().toISOString();

    await job.updateData({
      ...job.data,
      status: MENSAGENS_DISPATCH_PROCESSING_STATUS,
      started_at: startedAt,
    });

    await updateDispatchLogStatus(job.data.dispatch_log_id, "processando");

    try {
      logger.info &&
        logger.info(
          JSON.stringify({
            event: "mensagens_dispatch.started",
            job_id: job.id,
            group_id: job.data.group_id,
            internal_group_id: job.data.internal_group_id,
            scheduled_at: job.data.scheduled_at,
          })
        );

      const sendParams = { groupId: job.data.group_id };

      if (job.data.message) {
        sendParams.message = job.data.message;
      }

      if (job.data.content) {
        sendParams.content = job.data.content;
      }

      const result = await sender(sendParams);
      const completedAt = new Date().toISOString();

      await job.updateData({
        ...job.data,
        status: MENSAGENS_DISPATCH_SUCCESS_STATUS,
        started_at: startedAt,
        completed_at: completedAt,
      });

      await updateDispatchLogStatus(job.data.dispatch_log_id, "enviado");

      logger.info &&
        logger.info(
          JSON.stringify({
            event: "mensagens_dispatch.sent",
            job_id: job.id,
            group_id: job.data.group_id,
            internal_group_id: job.data.internal_group_id,
            started_at: startedAt,
            completed_at: completedAt,
          })
        );

      return {
        status: MENSAGENS_DISPATCH_SUCCESS_STATUS,
        delivery: result,
        started_at: startedAt,
        completed_at: completedAt,
      };
    } catch (error) {
      const failedAt = new Date().toISOString();

      await job.updateData({
        ...job.data,
        status: MENSAGENS_DISPATCH_FAILED_STATUS,
        started_at: startedAt,
        failed_at: failedAt,
        error_message: error.message,
      });

      await updateDispatchLogStatus(job.data.dispatch_log_id, "falhou", error.message);

      logger.error &&
        logger.error(
          JSON.stringify({
            event: "mensagens_dispatch.failed",
            job_id: job.id,
            group_id: job.data.group_id,
            internal_group_id: job.data.internal_group_id,
            started_at: startedAt,
            failed_at: failedAt,
            error_message: error.message,
          })
        );

      throw error;
    }
  };
}

const mensagensDispatchWorker = createMensagensDispatchProcessor();

function createMensagensDispatchWorker(options = {}) {
  const { sender = sendToEvolution, logger = console, dispatchLogs = dispatchLogsRepository, ...workerOptions } = options;

  return createWorker(
    queueNames.mensagensDispatch,
    createMensagensDispatchProcessor({ sender, logger, dispatchLogs }),
    workerOptions
  );
}

function createMensagensDispatchEvents(options = {}) {
  return createQueueEvents(queueNames.mensagensDispatch, options);
}

module.exports = {
  MENSAGENS_DISPATCH_FAILED_STATUS,
  MENSAGENS_DISPATCH_INITIAL_STATUS,
  MENSAGENS_DISPATCH_JOB_NAME,
  MENSAGENS_DISPATCH_PROCESSING_STATUS,
  MENSAGENS_DISPATCH_SUCCESS_STATUS,
  addJitteredMensagensDispatchJobs,
  addMensagensDispatchJob,
  buildMensagensJobData,
  createMensagensDispatchEvents,
  createMensagensDispatchProcessor,
  createMensagensDispatchWorker,
  mensagensDispatchWorker,
  get mensagensDispatchQueue() {
    return getMensagensDispatchQueue();
  },
};
