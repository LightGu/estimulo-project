const { closeQueueInfrastructure } = require("../src/queues/bullmq");
const {
  CAMPAIGN_TRIGGER_INITIAL_STATUS,
  addCampaignTriggerJob,
  campaignTriggerQueue,
} = require("../src/queues/campaign-trigger");

async function main() {
  const [, , campaignId, executionAtArg] = process.argv;

  if (!campaignId) {
    throw new Error(
      "Informe o campaign_id. Exemplo: npm run queue:campaign-trigger:test -- campaign-123"
    );
  }

  const job = await addCampaignTriggerJob({
    campaign_id: campaignId,
    execution_at: executionAtArg || new Date(),
    status: CAMPAIGN_TRIGGER_INITIAL_STATUS,
  });

  console.log(
    JSON.stringify(
      {
        queue: campaignTriggerQueue.name,
        job_id: job.id,
        name: job.name,
        data: job.data,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await campaignTriggerQueue.close();
    await closeQueueInfrastructure();
  });
