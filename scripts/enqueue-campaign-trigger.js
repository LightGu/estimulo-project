const { closeQueueInfrastructure } = require("../src/queues/bullmq");
const {
  CAMPAIGN_TRIGGER_INITIAL_STATUS,
  addCampaignTriggerJob,
  campaignTriggerQueue,
  removeCampaignSchedule,
  scheduleCampaign,
} = require("../src/queues/campaign-trigger");

function parseArgs(argv) {
  const args = {
    positional: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--cron") {
      args.cron_expression = argv[index + 1];
      index += 1;
    } else if (value === "--every") {
      args.every = argv[index + 1];
      index += 1;
    } else if (value === "--timezone" || value === "--tz") {
      args.timezone = argv[index + 1];
      index += 1;
    } else if (value === "--window-start") {
      args.window_start = argv[index + 1];
      index += 1;
    } else if (value === "--window-end") {
      args.window_end = argv[index + 1];
      index += 1;
    } else if (value === "--inactive") {
      args.active = false;
    } else if (value === "--remove") {
      args.remove = true;
    } else {
      args.positional.push(value);
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [campaignId, executionAtArg] = args.positional;

  if (!campaignId) {
    throw new Error(
      "Informe o campaign_id. Exemplo: npm run queue:campaign-trigger:test -- campaign-123 ou npm run queue:campaign-trigger:test -- campaign-123 --cron \"0 9 * * 1-5\""
    );
  }

  if (args.remove) {
    const result = await removeCampaignSchedule({
      campaign_id: campaignId,
    });

    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const job =
    args.cron_expression || args.every || args.active === false
      ? await scheduleCampaign({
          campaign_id: campaignId,
          cron_expression: args.cron_expression,
          every: args.every,
          timezone: args.timezone,
          window_start: args.window_start,
          window_end: args.window_end,
          active: args.active,
        })
      : await addCampaignTriggerJob({
          campaign_id: campaignId,
          execution_at: executionAtArg || new Date(),
          status: CAMPAIGN_TRIGGER_INITIAL_STATUS,
        });

  if (!job.name) {
    console.log(JSON.stringify(job, null, 2));
    return;
  }

  console.log(
    JSON.stringify(
      {
        queue: campaignTriggerQueue.name,
        job_id: job.id,
        repeat_job_key: job.repeatJobKey,
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
