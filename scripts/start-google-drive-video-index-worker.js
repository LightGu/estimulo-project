const { Sentry, initSentry } = require("../src/config/sentry");
initSentry({ serverName: "google-drive-video-index-worker" });

const { closeQueueInfrastructure } = require("../src/queues/bullmq");
const {
  createGoogleDriveVideoIndexEvents,
  createGoogleDriveVideoIndexWorker,
  googleDriveVideoIndexQueue,
  scheduleGoogleDriveVideoIndexJob,
} = require("../src/queues/google-drive-video-index");
const settingsRepository = require("../src/repositories/settings.repository");

const worker = createGoogleDriveVideoIndexWorker();
const events = createGoogleDriveVideoIndexEvents();

worker.on("ready", () => {
  console.log(`Worker da fila ${googleDriveVideoIndexQueue.name} iniciado`);
});

worker.on("active", (job) => {
  console.log(
    JSON.stringify({
      event: "google_drive_video_index.execution_started",
      job_id: job.id,
      root_folder_id: job.data.root_folder_id,
      schedule_key: job.data.schedule_key,
    })
  );
});

worker.on("failed", (job, error) => {
  console.error(
    JSON.stringify({
      event: "google_drive_video_index.execution_failed",
      job_id: job && job.id,
      root_folder_id: job && job.data && job.data.root_folder_id,
      attempts_made: job && job.attemptsMade,
      failed_reason: error.message,
    })
  );
});

events.on("completed", ({ jobId, returnvalue }) => {
  console.log(
    JSON.stringify({
      event: "google_drive_video_index.completed.event",
      job_id: jobId,
      returnvalue,
    })
  );
});

events.on("failed", ({ jobId, failedReason }) => {
  console.error(
    JSON.stringify({
      event: "google_drive_video_index.failed.event",
      job_id: jobId,
      failed_reason: failedReason,
    })
  );
});

async function scheduleRecurringIndexJob() {
  const settings = await settingsRepository.getSettings().catch(() => null);
  const scheduleParams = {};

  if (settings && settings.drive_index_cron) {
    scheduleParams.cron_expression = settings.drive_index_cron;
  }

  if (settings && settings.drive_index_timezone) {
    scheduleParams.timezone = settings.drive_index_timezone;
  }

  if (settings && settings.drive_root_folder_id) {
    scheduleParams.root_folder_id = settings.drive_root_folder_id;
  }

  const job = await scheduleGoogleDriveVideoIndexJob(scheduleParams);

  console.log(
    JSON.stringify({
      event: "google_drive_video_index.schedule_ready",
      queue: googleDriveVideoIndexQueue.name,
      job_id: job.id,
      repeat_job_key: job.repeatJobKey,
      schedule_key: job.data.schedule_key,
      recurrence: job.data.recurrence,
    })
  );
}

async function shutdown() {
  await worker.close();
  await events.close();
  await googleDriveVideoIndexQueue.close();
  await closeQueueInfrastructure();
}

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});

process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});

scheduleRecurringIndexJob().catch((error) => {
  console.error(
    JSON.stringify({
      event: "google_drive_video_index.schedule_failed",
      error_message: error.message,
    })
  );
  Sentry.captureException(error, { tags: { event: "google_drive_video_index.schedule_failed" } });
  shutdown().finally(() => process.exit(1));
});
