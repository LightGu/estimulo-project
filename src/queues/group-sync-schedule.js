const GROUP_SYNC_SCHEDULE_KEY = "group-sync-daily";
const DEFAULT_GROUP_SYNC_CRON = "0 2 * * *";

function buildGroupSyncRepeatOptions(params = {}) {
  const cronExpression =
    params.cron_expression ||
    params.cronExpression ||
    process.env.GROUP_SYNC_CRON ||
    DEFAULT_GROUP_SYNC_CRON;
  const timezone = params.timezone || params.tz || process.env.GROUP_SYNC_TIMEZONE || undefined;

  if (!cronExpression) {
    throw new Error("GROUP_SYNC_CRON e obrigatorio para agendar sincronizacao de grupos");
  }

  const repeatOptions = {
    key: GROUP_SYNC_SCHEDULE_KEY,
    pattern: cronExpression,
  };

  if (timezone) {
    repeatOptions.tz = timezone;
  }

  return repeatOptions;
}

function buildGroupSyncScheduleJobData(params = {}, repeatOptions, buildJobData) {
  if (typeof buildJobData !== "function") {
    throw new Error("buildJobData e obrigatorio para montar o job recorrente de grupos");
  }

  const jobData = buildJobData(params);

  return {
    ...jobData,
    schedule_key: repeatOptions.key,
    trigger_type: "recurring",
    recurrence: {
      pattern: repeatOptions.pattern,
      timezone: repeatOptions.tz,
    },
  };
}

module.exports = {
  DEFAULT_GROUP_SYNC_CRON,
  GROUP_SYNC_SCHEDULE_KEY,
  buildGroupSyncRepeatOptions,
  buildGroupSyncScheduleJobData,
};
