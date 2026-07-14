const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_STATE_FILE_PATH = path.resolve(
  process.cwd(),
  "storage",
  "google-drive-video-index-state.json"
);

function createInitialState() {
  return {
    roots: {},
  };
}

function readStateFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return createInitialState();
  }

  const rawContent = fs.readFileSync(filePath, "utf8").trim();

  if (!rawContent) {
    return createInitialState();
  }

  const parsed = JSON.parse(rawContent);

  return {
    roots: parsed.roots && typeof parsed.roots === "object" ? parsed.roots : {},
  };
}

function ensureStateDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeStateFile(filePath, state) {
  ensureStateDirectory(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function validateDateISOString(value, fieldName) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} deve ser uma data valida`);
  }

  return date.toISOString();
}

function createGoogleDriveVideoIndexStateStore(options = {}) {
  const filePath = options.filePath || process.env.GOOGLE_DRIVE_VIDEO_INDEX_STATE_FILE || DEFAULT_STATE_FILE_PATH;

  return {
    async getLastSuccessfulIndexAt(params = {}) {
      if (!params.rootFolderId) {
        throw new Error("rootFolderId e obrigatorio para ler o estado da indexacao");
      }

      const state = readStateFile(filePath);
      const rootState = state.roots[params.rootFolderId];

      return rootState && rootState.last_successful_index_at;
    },

    async saveSuccessfulIndex(params = {}) {
      if (!params.rootFolderId) {
        throw new Error("rootFolderId e obrigatorio para salvar o estado da indexacao");
      }

      const indexedAt = validateDateISOString(params.indexedAt, "indexedAt");
      const state = readStateFile(filePath);

      state.roots[params.rootFolderId] = {
        root_folder_id: params.rootFolderId,
        root_folder_name: params.rootFolderName,
        last_successful_index_at: indexedAt,
        last_completed_at: params.completedAt
          ? validateDateISOString(params.completedAt, "completedAt")
          : indexedAt,
        last_job_id: params.jobId,
        last_processed_count: params.processedCount,
        last_indexed_count: params.indexedCount,
        last_skipped_count: params.skippedCount,
        last_error_count: params.errorCount,
      };

      writeStateFile(filePath, state);

      return state.roots[params.rootFolderId];
    },
  };
}

module.exports = {
  DEFAULT_STATE_FILE_PATH,
  createGoogleDriveVideoIndexStateStore,
};
