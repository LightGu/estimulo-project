require("dotenv").config({ quiet: true });

const { closeQueueInfrastructure } = require("../src/queues/bullmq");
const {
  createDispatchFailureRetryEvents,
  createDispatchFailureRetryWorker,
  dispatchFailureRetryQueue,
  scheduleDispatchFailureRetrySweep,
} = require("../src/queues/dispatch-failure-retry");

const worker = createDispatchFailureRetryWorker();
const events = createDispatchFailureRetryEvents();

worker.on("ready", () => {
  console.log(`Worker da fila ${dispatchFailureRetryQueue.name} iniciado`);
});

events.on("completed", ({ jobId, returnvalue }) => {
  console.log(
    JSON.stringify({
      event: "dispatch_failure_retry.completed",
      job_id: jobId,
      returnvalue,
    })
  );
});

events.on("failed", ({ jobId, failedReason }) => {
  console.error(
    JSON.stringify({
      event: "dispatch_failure_retry.failed.event",
      job_id: jobId,
      failed_reason: failedReason,
    })
  );
});

async function shutdown() {
  await worker.close();
  await events.close();
  await dispatchFailureRetryQueue.close();
  await closeQueueInfrastructure();
}

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});

process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});

scheduleDispatchFailureRetrySweep().catch((error) => {
  console.error(
    JSON.stringify({
      event: "dispatch_failure_retry.schedule_failed",
      error_message: error.message,
    })
  );
  shutdown().finally(() => process.exit(1));
});
