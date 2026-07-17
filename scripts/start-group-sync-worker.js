const { closeQueueInfrastructure } = require("../src/queues/bullmq");
const {
  createGroupSyncEvents,
  createGroupSyncWorker,
  groupSyncQueue,
  scheduleGroupSyncJob,
} = require("../src/queues/group-sync");

const worker = createGroupSyncWorker();
const events = createGroupSyncEvents();

worker.on("ready", () => {
  console.log(`Worker da fila ${groupSyncQueue.name} iniciado`);
});

worker.on("active", (job) => {
  console.log(
    JSON.stringify({
      event: "group_sync.execution_started",
      job_id: job.id,
      organization_id: job.data.organization_id,
      schedule_key: job.data.schedule_key,
    })
  );
});

worker.on("failed", (job, error) => {
  console.error(
    JSON.stringify({
      event: "group_sync.execution_failed",
      job_id: job && job.id,
      organization_id: job && job.data && job.data.organization_id,
      attempts_made: job && job.attemptsMade,
      failed_reason: error.message,
    })
  );
});

events.on("completed", ({ jobId, returnvalue }) => {
  console.log(
    JSON.stringify({
      event: "group_sync.completed.event",
      job_id: jobId,
      returnvalue,
    })
  );
});

events.on("failed", ({ jobId, failedReason }) => {
  console.error(
    JSON.stringify({
      event: "group_sync.failed.event",
      job_id: jobId,
      failed_reason: failedReason,
    })
  );
});

async function scheduleRecurringGroupSyncJob() {
  const job = await scheduleGroupSyncJob();

  console.log(
    JSON.stringify({
      event: "group_sync.schedule_ready",
      queue: groupSyncQueue.name,
      job_id: job.id,
      repeat_job_key: job.repeatJobKey,
      schedule_key: job.data.schedule_key,
      organization_id: job.data.organization_id,
      recurrence: job.data.recurrence,
    })
  );
}

async function shutdown() {
  await worker.close();
  await events.close();
  await groupSyncQueue.close();
  await closeQueueInfrastructure();
}

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});

process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});

scheduleRecurringGroupSyncJob().catch((error) => {
  console.error(
    JSON.stringify({
      event: "group_sync.schedule_failed",
      error_message: error.message,
    })
  );
  shutdown().finally(() => process.exit(1));
});
