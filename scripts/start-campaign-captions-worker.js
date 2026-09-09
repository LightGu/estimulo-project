require("dotenv").config({ quiet: true });

const { Sentry, initSentry } = require("../src/config/sentry");
initSentry({ serverName: "campaign-captions-worker" });

const { closeQueueInfrastructure } = require("../src/queues/bullmq");
const {
  campaignCaptionsQueue,
  createCampaignCaptionsEvents,
  createCampaignCaptionsWorker,
  resolveCampaignCaptionsConcurrency,
  resolveCampaignCaptionsLockMs,
} = require("../src/queues/campaign-captions");

const worker = createCampaignCaptionsWorker();
const events = createCampaignCaptionsEvents();

worker.on("ready", () => {
  console.log(
    JSON.stringify({
      event: "campaign_captions.worker_ready",
      queue: campaignCaptionsQueue.name,
      concurrency: resolveCampaignCaptionsConcurrency(),
      lock_duration_ms: resolveCampaignCaptionsLockMs(),
    })
  );
});

events.on("completed", ({ jobId, returnvalue }) => {
  console.log(
    JSON.stringify({
      event: "campaign_captions.completed.event",
      job_id: jobId,
      returnvalue,
    })
  );
});

events.on("failed", ({ jobId, failedReason }) => {
  console.error(
    JSON.stringify({
      event: "campaign_captions.failed.event",
      job_id: jobId,
      failed_reason: failedReason,
    })
  );
});

async function shutdown() {
  await worker.close();
  await events.close();
  await campaignCaptionsQueue.close();
  await closeQueueInfrastructure();
}

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});

process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});

// Diferente dos workers de sweep, esta fila nao tem job repetitivo para agendar:
// os jobs entram sob demanda, no dispatchCampaign. Um erro de infraestrutura na
// subida aparece pelo listener de "error" que createWorker registra.
worker.on("error", (error) => {
  Sentry.captureException(error, { tags: { queue: campaignCaptionsQueue.name, kind: "worker_boot" } });
});
