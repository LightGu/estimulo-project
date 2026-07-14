const assert = require("node:assert/strict");

const {
  GOOGLE_DRIVE_VIDEO_INDEX_SCHEDULE_KEY,
  buildGoogleDriveVideoIndexRepeatOptions,
  buildGoogleDriveVideoIndexScheduleJobData,
} = require("../src/queues/google-drive-video-index-schedule");

async function testBuildsRepeatOptionsFromParams() {
  const repeatOptions = buildGoogleDriveVideoIndexRepeatOptions({
    cron_expression: "0 4 * * *",
    timezone: "America/Bahia",
  });

  assert.equal(repeatOptions.key, GOOGLE_DRIVE_VIDEO_INDEX_SCHEDULE_KEY);
  assert.equal(repeatOptions.pattern, "0 4 * * *");
  assert.equal(repeatOptions.tz, "America/Bahia");
}

async function testBuildsRecurringJobData() {
  const repeatOptions = buildGoogleDriveVideoIndexRepeatOptions({
    cron_expression: "0 4 * * *",
    timezone: "America/Bahia",
  });
  const buildJobData = (params) => ({
    root_folder_id: params.root_folder_id,
    root_folder_name: params.root_folder_name,
    status: "pending",
  });
  const jobData = buildGoogleDriveVideoIndexScheduleJobData(
    {
      root_folder_id: "root",
      root_folder_name: "Conteudos",
    },
    repeatOptions,
    buildJobData
  );

  assert.equal(jobData.root_folder_id, "root");
  assert.equal(jobData.schedule_key, GOOGLE_DRIVE_VIDEO_INDEX_SCHEDULE_KEY);
  assert.equal(jobData.trigger_type, "recurring");
  assert.deepEqual(jobData.recurrence, {
    pattern: "0 4 * * *",
    timezone: "America/Bahia",
  });
}

async function main() {
  await testBuildsRepeatOptionsFromParams();
  await testBuildsRecurringJobData();

  console.log("google-drive-video-index-schedule tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
