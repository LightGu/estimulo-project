const { closeQueueInfrastructure } = require("../src/queues/bullmq");
const {
  createDispatchEvents,
  createDispatchWorker,
  dispatchQueue,
} = require("../src/queues/dispatch");

const worker = createDispatchWorker();
const events = createDispatchEvents();

worker.on("ready", () => {
  console.log(`Worker da fila ${dispatchQueue.name} iniciado`);
});

events.on("completed", ({ jobId, returnvalue }) => {
  console.log(
    JSON.stringify({
      event: "dispatch.completed",
      job_id: jobId,
      returnvalue,
    })
  );
});

events.on("failed", ({ jobId, failedReason }) => {
  console.error(
    JSON.stringify({
      event: "dispatch.failed.event",
      job_id: jobId,
      failed_reason: failedReason,
    })
  );
});

async function shutdown() {
  await worker.close();
  await events.close();
  await dispatchQueue.close();
  await closeQueueInfrastructure();
}

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});

process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});
