const process = require("node:process");

const { createGoogleDriveClient } = require("../services/google-drive");
const {
  createGoogleDriveVideoIndexStateStore,
} = require("../services/google-drive-video-index-state");
const { indexGoogleDriveVideos } = require("../services/google-drive-video-indexer");
const { createQueue, createQueueEvents, createWorker } = require("./bullmq");
const {
  GOOGLE_DRIVE_VIDEO_INDEX_SCHEDULE_KEY,
  buildGoogleDriveVideoIndexRepeatOptions,
  buildGoogleDriveVideoIndexScheduleJobData: buildScheduleJobData,
} = require("./google-drive-video-index-schedule");
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

function buildGoogleDriveVideoIndexScheduleJobData(params = {}, repeatOptions) {
  return buildScheduleJobData(params, repeatOptions, buildGoogleDriveVideoIndexJobData);
}

async function scheduleGoogleDriveVideoIndexJob(params = {}, options = {}) {
  const repeatOptions = buildGoogleDriveVideoIndexRepeatOptions(params);
  const jobData = buildGoogleDriveVideoIndexScheduleJobData(params, repeatOptions);
  const { repeat: _ignoredRepeatOptions, ...jobOptionOverrides } = options;

  return googleDriveVideoIndexQueue.add(GOOGLE_DRIVE_VIDEO_INDEX_JOB_NAME, jobData, {
    ...jobOptionOverrides,
    repeat: repeatOptions,
  });
}

function createGoogleDriveVideoIndexProcessor(options = {}) {
  const {
    drive: providedDrive,
    indexer = indexGoogleDriveVideos,
    stateStore = createGoogleDriveVideoIndexStateStore(),
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

      const modifiedTimeAfter = job.data.force_full_index
        ? undefined
        : await stateStore.getLastSuccessfulIndexAt({
            rootFolderId: job.data.root_folder_id,
          });
      const modifiedTimeBefore = startedAt;

      logger.info &&
        logger.info(
          JSON.stringify({
            event: "google_drive_video_index.started",
            job_id: job.id,
            root_folder_id: job.data.root_folder_id,
            mode: modifiedTimeAfter ? "incremental" : "full",
            modified_time_after: modifiedTimeAfter,
            modified_time_before: modifiedTimeBefore,
          })
        );

      const result = await indexer({
        drive,
        rootFolderId: job.data.root_folder_id,
        rootFolderName: job.data.root_folder_name,
        modifiedTimeAfter,
        modifiedTimeBefore,
        upsertVideo,
        logger,
      });
      const completedAt = new Date().toISOString();

      await stateStore.saveSuccessfulIndex({
        rootFolderId: job.data.root_folder_id,
        rootFolderName: job.data.root_folder_name,
        indexedAt: modifiedTimeBefore,
        completedAt,
        jobId: job.id,
        processedCount: result.processed_count,
        indexedCount: result.indexed_count,
        skippedCount: result.skipped_count,
        errorCount: result.error_count,
      });

      await job.updateData({
        ...job.data,
        status: GOOGLE_DRIVE_VIDEO_INDEX_SUCCESS_STATUS,
        started_at: startedAt,
        completed_at: completedAt,
        modified_time_after: modifiedTimeAfter,
        modified_time_before: modifiedTimeBefore,
        processed_count: result.processed_count,
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
            modified_time_after: modifiedTimeAfter,
            modified_time_before: modifiedTimeBefore,
            processed_count: result.processed_count,
            indexed_count: result.indexed_count,
            skipped_count: result.skipped_count,
            error_count: result.error_count,
          })
        );

      return {
        status: GOOGLE_DRIVE_VIDEO_INDEX_SUCCESS_STATUS,
        started_at: startedAt,
        completed_at: completedAt,
        modified_time_after: modifiedTimeAfter,
        modified_time_before: modifiedTimeBefore,
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
  const { drive, indexer, stateStore, upsertVideo, logger, ...workerOptions } = options;

  return createWorker(
    queueNames.googleDriveVideoIndex,
    createGoogleDriveVideoIndexProcessor({ drive, indexer, stateStore, upsertVideo, logger }),
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
  GOOGLE_DRIVE_VIDEO_INDEX_SCHEDULE_KEY,
  GOOGLE_DRIVE_VIDEO_INDEX_SUCCESS_STATUS,
  addGoogleDriveVideoIndexJob,
  buildGoogleDriveVideoIndexRepeatOptions,
  buildGoogleDriveVideoIndexScheduleJobData,
  buildGoogleDriveVideoIndexJobData,
  createGoogleDriveVideoIndexEvents,
  createGoogleDriveVideoIndexProcessor,
  createGoogleDriveVideoIndexWorker,
  googleDriveVideoIndexQueue,
  scheduleGoogleDriveVideoIndexJob,
};
