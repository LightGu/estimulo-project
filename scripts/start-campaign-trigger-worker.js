const { closeQueueInfrastructure } = require("../src/queues/bullmq");
const {
  campaignTriggerQueue,
  createCampaignTriggerEvents,
  createCampaignTriggerWorker,
} = require("../src/queues/campaign-trigger");

const worker = createCampaignTriggerWorker();
const events = createCampaignTriggerEvents();

worker.on("ready", () => {
  console.log(`Worker da fila ${campaignTriggerQueue.name} iniciado`);
});

worker.on("active", (job) => {
  console.log(
    JSON.stringify({
      event: "campaign_trigger.execution_started",
      job_id: job.id,
      campaign_id: job.data.campaign_id,
      schedule_key: job.data.schedule_key,
    })
  );
});

worker.on("failed", (job, error) => {
  console.error(
    JSON.stringify({
      event: "campaign_trigger.execution_failed",
      job_id: job && job.id,
      campaign_id: job && job.data && job.data.campaign_id,
      attempts_made: job && job.attemptsMade,
      failed_reason: error.message,
    })
  );
});

events.on("completed", ({ jobId, returnvalue }) => {
  console.log(
    JSON.stringify({
      event: "campaign_trigger.completed.event",
      job_id: jobId,
      returnvalue,
    })
  );
});

events.on("failed", ({ jobId, failedReason }) => {
  console.error(
    JSON.stringify({
      event: "campaign_trigger.failed.event",
      job_id: jobId,
      failed_reason: failedReason,
    })
  );
});

async function shutdown() {
  await worker.close();
  await events.close();
  await campaignTriggerQueue.close();
  await closeQueueInfrastructure();
}

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});

process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});
