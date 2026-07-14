const { closeQueueInfrastructure } = require("../src/queues/bullmq");
const {
  createGoogleDriveVideoIndexEvents,
  createGoogleDriveVideoIndexWorker,
  googleDriveVideoIndexQueue,
} = require("../src/queues/google-drive-video-index");

const worker = createGoogleDriveVideoIndexWorker();
const events = createGoogleDriveVideoIndexEvents();

worker.on("ready", () => {
  console.log(`Worker da fila ${googleDriveVideoIndexQueue.name} iniciado`);
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
