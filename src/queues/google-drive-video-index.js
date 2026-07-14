const process = require("node:process");

const { createGoogleDriveClient } = require("../services/google-drive");
const { indexGoogleDriveVideos } = require("../services/google-drive-video-indexer");
const { createQueue, createQueueEvents, createWorker } = require("./bullmq");
const { queueNames } = require("./names");

const GOOGLE_DRIVE_VIDEO_INDEX_JOB_NAME = "index-google-drive-videos";
const GOOGLE_DRIVE_VIDEO_INDEX_INITIAL_STATUS = "pending";
const GOOGLE_DRIVE_VIDEO_INDEX_PROCESSING_STATUS = "processing";
const GOOGLE_DRIVE_VIDEO_INDEX_SUCCESS_STATUS = "completed";
const GOOGLE_DRIVE_VIDEO_INDEX_FAILED_STATUS = "failed";

const googleDriveVideoIndexQueue = createQueue(queueNames.googleDriveVideoIndex);

function buildGoogleDriveVideoIndexJobData(params = {}) {
  const rootFolderId = params.root_folder_id || params.rootFolderId || process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;

  if (!rootFolderId) {
    throw new Error("root_folder_id ou GOOGLE_DRIVE_ROOT_FOLDER_ID e obrigatorio para indexar videos");
  }

  return {
    root_folder_id: rootFolderId,
    root_folder_name: params.root_folder_name || params.rootFolderName || "root",
    status: params.status || GOOGLE_DRIVE_VIDEO_INDEX_INITIAL_STATUS,
    requested_at: (params.requested_at ? new Date(params.requested_at) : new Date()).toISOString(),
  };
}

async function addGoogleDriveVideoIndexJob(params = {}, options = {}) {
  const jobData = buildGoogleDriveVideoIndexJobData(params);

  return googleDriveVideoIndexQueue.add(GOOGLE_DRIVE_VIDEO_INDEX_JOB_NAME, jobData, options);
}

function createGoogleDriveVideoIndexProcessor(options = {}) {
  const {
    drive: providedDrive,
    indexer = indexGoogleDriveVideos,
    upsertVideo,
    logger = console,
  } = options;
  let drive = providedDrive;

  return async function googleDriveVideoIndexWorker(job) {
    const startedAt = new Date().toISOString();

    await job.updateData({
      ...job.data,
      status: GOOGLE_DRIVE_VIDEO_INDEX_PROCESSING_STATUS,
      started_at: startedAt,
    });

    try {
      if (!drive) {
        drive = createGoogleDriveClient();
      }

      const result = await indexer({
        drive,
        rootFolderId: job.data.root_folder_id,
        rootFolderName: job.data.root_folder_name,
        upsertVideo,
        logger,
      });
      const completedAt = new Date().toISOString();

      await job.updateData({
        ...job.data,
        status: GOOGLE_DRIVE_VIDEO_INDEX_SUCCESS_STATUS,
        started_at: startedAt,
        completed_at: completedAt,
        indexed_count: result.indexed_count,
        skipped_count: result.skipped_count,
        error_count: result.error_count,
      });

      logger.info &&
        logger.info(
          JSON.stringify({
            event: "google_drive_video_index.completed",
            job_id: job.id,
            root_folder_id: job.data.root_folder_id,
            indexed_count: result.indexed_count,
            skipped_count: result.skipped_count,
            error_count: result.error_count,
          })
        );

      return {
        status: GOOGLE_DRIVE_VIDEO_INDEX_SUCCESS_STATUS,
        started_at: startedAt,
        completed_at: completedAt,
        ...result,
      };
    } catch (error) {
      const failedAt = new Date().toISOString();

      await job.updateData({
        ...job.data,
        status: GOOGLE_DRIVE_VIDEO_INDEX_FAILED_STATUS,
        started_at: startedAt,
        failed_at: failedAt,
        error_message: error.message,
      });

      logger.error &&
        logger.error(
          JSON.stringify({
            event: "google_drive_video_index.failed",
            job_id: job.id,
            root_folder_id: job.data.root_folder_id,
            error_message: error.message,
          })
        );

      throw error;
    }
  };
}

function createGoogleDriveVideoIndexWorker(options = {}) {
  const { drive, indexer, upsertVideo, logger, ...workerOptions } = options;

  return createWorker(
    queueNames.googleDriveVideoIndex,
    createGoogleDriveVideoIndexProcessor({ drive, indexer, upsertVideo, logger }),
    workerOptions
  );
}

function createGoogleDriveVideoIndexEvents(options = {}) {
  return createQueueEvents(queueNames.googleDriveVideoIndex, options);
}

module.exports = {
  GOOGLE_DRIVE_VIDEO_INDEX_FAILED_STATUS,
  GOOGLE_DRIVE_VIDEO_INDEX_INITIAL_STATUS,
  GOOGLE_DRIVE_VIDEO_INDEX_JOB_NAME,
  GOOGLE_DRIVE_VIDEO_INDEX_PROCESSING_STATUS,
  GOOGLE_DRIVE_VIDEO_INDEX_SUCCESS_STATUS,
  addGoogleDriveVideoIndexJob,
  buildGoogleDriveVideoIndexJobData,
  createGoogleDriveVideoIndexEvents,
  createGoogleDriveVideoIndexProcessor,
  createGoogleDriveVideoIndexWorker,
  googleDriveVideoIndexQueue,
};
