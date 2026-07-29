require("dotenv").config({ quiet: true });

const { closeQueueInfrastructure } = require("../src/queues/bullmq");
const {
  createDispatchReviewTimeoutEvents,
  createDispatchReviewTimeoutWorker,
  dispatchReviewTimeoutQueue,
  scheduleDispatchReviewTimeoutSweep,
} = require("../src/queues/dispatch-review-timeout");

const worker = createDispatchReviewTimeoutWorker();
const events = createDispatchReviewTimeoutEvents();

worker.on("ready", () => {
  console.log(`Worker da fila ${dispatchReviewTimeoutQueue.name} iniciado`);
});

events.on("completed", ({ jobId, returnvalue }) => {
  console.log(
    JSON.stringify({
      event: "dispatch_review_timeout.completed",
      job_id: jobId,
      returnvalue,
    })
  );
});

events.on("failed", ({ jobId, failedReason }) => {
  console.error(
    JSON.stringify({
      event: "dispatch_review_timeout.failed.event",
      job_id: jobId,
      failed_reason: failedReason,
    })
  );
});

async function shutdown() {
  await worker.close();
  await events.close();
  await dispatchReviewTimeoutQueue.close();
  await closeQueueInfrastructure();
}

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});

process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});

scheduleDispatchReviewTimeoutSweep().catch((error) => {
  console.error(
    JSON.stringify({
      event: "dispatch_review_timeout.schedule_failed",
      error_message: error.message,
    })
  );
  shutdown().finally(() => process.exit(1));
});
