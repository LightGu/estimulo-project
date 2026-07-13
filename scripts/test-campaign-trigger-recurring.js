process.env.REDIS_DB = process.env.REDIS_TEST_DB || "15";

const { closeQueueInfrastructure } = require("../src/queues/bullmq");
const {
  buildCampaignScheduleKey,
  campaignTriggerQueue,
  createCampaignTriggerEvents,
  createCampaignTriggerWorker,
  removeCampaignSchedule,
  scheduleCampaign,
} = require("../src/queues/campaign-trigger");

const campaignId = `campaign-recurring-local-${Date.now()}`;
const cronExpression = "*/2 * * * * *";
const targetExecutions = 4;
const forcedFailureExecution = 2;
const timeoutMs = 20000;

const executions = [];
const events = [];

function nowIso() {
  return new Date().toISOString();
}

function scheduledAtFromJob(job) {
  const scheduledMillis = job.opts.prevMillis || job.timestamp;
  return new Date(scheduledMillis).toISOString();
}

function writeLog(entry) {
  console.log(JSON.stringify(entry));
}

async function waitFor(condition, timeoutMessage) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(timeoutMessage);
}

async function listCampaignSchedules() {
  const repeatableJobs = await campaignTriggerQueue.getRepeatableJobs();

  return repeatableJobs.filter((job) => job.key === buildCampaignScheduleKey(campaignId));
}

async function main() {
  const queueEvents = createCampaignTriggerEvents();

  queueEvents.on("completed", ({ jobId, returnvalue }) => {
    events.push({ status: "completed", job_id: jobId, returnvalue, event_at: nowIso() });
  });

  queueEvents.on("failed", ({ jobId, failedReason }) => {
    events.push({ status: "failed", job_id: jobId, failed_reason: failedReason, event_at: nowIso() });
  });

  await queueEvents.waitUntilReady();

  const worker = createCampaignTriggerWorker(
    async (job) => {
      const executionNumber = executions.length + 1;
      const startedAt = nowIso();
      const scheduledAt = scheduledAtFromJob(job);
      const baseLog = {
        campaign_id: job.data.campaign_id,
        job_id: job.id,
        scheduled_at: scheduledAt,
        started_at: startedAt,
      };

      if (executionNumber === forcedFailureExecution) {
        const failedAt = nowIso();
        const failureLog = {
          ...baseLog,
          completed_at: failedAt,
          status: "failed",
          error_message: "falha simulada no processor",
        };

        executions.push(failureLog);
        writeLog({ type: "worker_execution", ...failureLog });
        throw new Error("falha simulada no processor");
      }

      await new Promise((resolve) => setTimeout(resolve, 100));

      const completedAt = nowIso();
      const successLog = {
        ...baseLog,
        completed_at: completedAt,
        status: "completed",
      };

      executions.push(successLog);
      writeLog({ type: "worker_execution", ...successLog });

      return {
        campaign_id: job.data.campaign_id,
        status: "processed",
        processed_at: completedAt,
      };
    },
    {
      concurrency: 1,
    }
  );

  try {
    const scheduledJob = await scheduleCampaign(
      {
        campaign_id: campaignId,
        cron_expression: cronExpression,
        timezone: "America/Bahia",
      },
      {
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      }
    );

    writeLog({
      type: "schedule_created",
      campaign_id: campaignId,
      queue: campaignTriggerQueue.name,
      redis_db: process.env.REDIS_DB,
      job_id: scheduledJob.id,
      repeat_job_key: scheduledJob.repeatJobKey,
      cron_expression: cronExpression,
      timezone: "America/Bahia",
      status: "scheduled",
    });

    await waitFor(
      async () => (await listCampaignSchedules()).length === 1,
      "agendamento repeatable nao foi encontrado na fila"
    );

    const schedules = await listCampaignSchedules();
    writeLog({
      type: "repeatable_found",
      campaign_id: campaignId,
      schedule_key: schedules[0].key,
      next_execution_at: new Date(schedules[0].next).toISOString(),
      status: "found",
    });

    await waitFor(
      () =>
        executions.length >= targetExecutions &&
        executions.some((execution) => execution.status === "failed") &&
        executions.slice(forcedFailureExecution).some((execution) => execution.status === "completed"),
      "o worker nao processou as execucoes recorrentes esperadas dentro do tempo limite"
    );

    await waitFor(
      () =>
        events.some((event) => event.status === "failed") &&
        events.filter((event) => event.status === "completed").length >= targetExecutions - 1,
      "os eventos de completed/failed esperados nao foram registrados dentro do tempo limite"
    );

    const removal = await removeCampaignSchedule({ campaign_id: campaignId });
    const remainingSchedules = await listCampaignSchedules();

    writeLog({
      type: "schedule_removed",
      campaign_id: campaignId,
      schedule_key: removal.schedule_key,
      removed: removal.removed,
      remaining_schedules: remainingSchedules.length,
      status: removal.removed && remainingSchedules.length === 0 ? "removed" : "not_removed",
    });

    writeLog({
      type: "test_summary",
      campaign_id: campaignId,
      worker_executions: executions.length,
      completed_executions: executions.filter((execution) => execution.status === "completed").length,
      failed_executions: executions.filter((execution) => execution.status === "failed").length,
      queue_completed_events: events.filter((event) => event.status === "completed").length,
      queue_failed_events: events.filter((event) => event.status === "failed").length,
      recurring_continued_after_failure: executions
        .slice(forcedFailureExecution)
        .some((execution) => execution.status === "completed"),
      schedule_removed: removal.removed && remainingSchedules.length === 0,
      status: "passed",
    });
  } finally {
    await removeCampaignSchedule({ campaign_id: campaignId }).catch(() => undefined);
    await worker.close();
    await queueEvents.close();
    await campaignTriggerQueue.close();
    await closeQueueInfrastructure();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
