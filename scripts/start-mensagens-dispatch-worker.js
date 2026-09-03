require("dotenv").config({ quiet: true });

const { initSentry } = require("../src/config/sentry");
initSentry({ serverName: "mensagens-dispatch-worker" });

const { clearLoopbackDiscardProxyEnv } = require("../src/config/network");
clearLoopbackDiscardProxyEnv(process.env, { logger: console });

const { closeQueueInfrastructure } = require("../src/queues/bullmq");
const {
  createMensagensDispatchEvents,
  createMensagensDispatchWorker,
  mensagensDispatchQueue,
} = require("../src/queues/mensagens-dispatch");

const worker = createMensagensDispatchWorker();
const events = createMensagensDispatchEvents();

worker.on("ready", () => {
  console.log(`Worker da fila ${mensagensDispatchQueue.name} iniciado`);
});

worker.on("active", (job) => {
  console.log(
    JSON.stringify({
      event: "mensagens_dispatch.active",
      job_id: job.id,
      group_id: job.data.group_id,
      scheduled_at: job.data.scheduled_at,
    })
  );
});

events.on("completed", ({ jobId, returnvalue }) => {
  console.log(
    JSON.stringify({
      event: "mensagens_dispatch.completed",
      job_id: jobId,
      returnvalue,
    })
  );
});

events.on("failed", ({ jobId, failedReason }) => {
  console.error(
    JSON.stringify({
      event: "mensagens_dispatch.failed.event",
      job_id: jobId,
      failed_reason: failedReason,
    })
  );
});

async function shutdown() {
  await worker.close();
  await events.close();
  await mensagensDispatchQueue.close();
  await closeQueueInfrastructure();
}

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});

process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});
