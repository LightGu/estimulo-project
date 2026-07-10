const { closeQueueInfrastructure } = require("../src/queues/bullmq");
const {
  DISPATCH_INITIAL_STATUS,
  addDispatchJob,
  dispatchQueue,
} = require("../src/queues/dispatch");

async function main() {
  const [, , groupId, campaignId, linkVideo, legendaArg, scheduledAtArg] = process.argv;

  if (!groupId || !campaignId || !linkVideo || !legendaArg) {
    throw new Error(
      "Informe group_id, campaign_id, link_video e legenda. Exemplo: npm run queue:dispatch:test -- 120363000000000000@g.us campaign-123 https://example.com/video.mp4 \"Legenda de teste\""
    );
  }

  const job = await addDispatchJob({
    group_id: groupId,
    campaign_id: campaignId,
    link_video: linkVideo,
    legenda: legendaArg,
    scheduled_at: scheduledAtArg || new Date(),
    status: DISPATCH_INITIAL_STATUS,
  });

  console.log(
    JSON.stringify(
      {
        queue: dispatchQueue.name,
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
    await dispatchQueue.close();
    await closeQueueInfrastructure();
  });
