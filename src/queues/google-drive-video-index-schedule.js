const GOOGLE_DRIVE_VIDEO_INDEX_SCHEDULE_KEY = "google-drive-video-index-daily";
const DEFAULT_GOOGLE_DRIVE_VIDEO_INDEX_CRON = "0 3 * * *";

function buildGoogleDriveVideoIndexRepeatOptions(params = {}) {
  const cronExpression =
    params.cron_expression ||
    params.cronExpression ||
    process.env.GOOGLE_DRIVE_VIDEO_INDEX_CRON ||
    DEFAULT_GOOGLE_DRIVE_VIDEO_INDEX_CRON;
  const timezone =
    params.timezone || params.tz || process.env.GOOGLE_DRIVE_VIDEO_INDEX_TIMEZONE || undefined;

  if (!cronExpression) {
    throw new Error("GOOGLE_DRIVE_VIDEO_INDEX_CRON e obrigatorio para agendar indexacao do Google Drive");
  }

  const repeatOptions = {
    key: GOOGLE_DRIVE_VIDEO_INDEX_SCHEDULE_KEY,
    pattern: cronExpression,
  };

  if (timezone) {
    repeatOptions.tz = timezone;
  }

  return repeatOptions;
}

function buildGoogleDriveVideoIndexScheduleJobData(params = {}, repeatOptions, buildJobData) {
  if (typeof buildJobData !== "function") {
    throw new Error("buildJobData e obrigatorio para montar o job recorrente de indexacao");
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
  DEFAULT_GOOGLE_DRIVE_VIDEO_INDEX_CRON,
  GOOGLE_DRIVE_VIDEO_INDEX_SCHEDULE_KEY,
  buildGoogleDriveVideoIndexRepeatOptions,
  buildGoogleDriveVideoIndexScheduleJobData,
};
