const assert = require("node:assert/strict");

const {
  buildFolderChildrenQuery,
  FOLDER_MIME_TYPE,
  SHORTCUT_MIME_TYPE,
  indexGoogleDriveVideos,
  isValidVideoFile,
} = require("../src/services/google-drive-video-indexer");

function createFakeDrive(tree, failures = new Set(), filesById = {}) {
  return {
    files: {
      async list(params) {
        const folderId = params.q.match(/'([^']+)' in parents/)[1];

        if (failures.has(folderId)) {
          throw new Error(`Falha simulada na pasta ${folderId}`);
        }

        return {
          data: {
            files: tree[folderId] || [],
          },
        };
      },
      async get(params) {
        const file = filesById[params.fileId];

        if (!file) {
          throw new Error(`Arquivo simulado nao encontrado: ${params.fileId}`);
        }

        return { data: file };
      },
    },
  };
}

async function testRecursiveIndexingMapsBasicCatalogFields() {
  const drive = createFakeDrive({
    root: [
      { id: "step-1", name: "Etapa 01", mimeType: FOLDER_MIME_TYPE },
      { id: "doc-1", name: "briefing.pdf", mimeType: "application/pdf" },
    ],
    "step-1": [{ id: "persona-p", name: "#P01 - Persona Paulo", mimeType: FOLDER_MIME_TYPE }],
    "persona-p": [
      {
        id: "video-1",
        name: "intro.mp4",
        mimeType: "video/mp4",
        fileExtension: "mp4",
        webViewLink: "https://drive.google.com/file/d/video-1/view",
        createdTime: "2026-07-01T00:00:00.000Z",
        parents: ["persona-p"],
      },
    ],
  });

  const persisted = [];
  const result = await indexGoogleDriveVideos({
    drive,
    rootFolderId: "root",
    rootFolderName: "Conteudos",
    upsertVideo: async (video) => persisted.push(video),
    logger: {},
  });

  assert.equal(result.indexed_count, 1);
  assert.equal(result.skipped_count, 1);
  assert.equal(result.error_count, 0);
  assert.equal(result.videos[0].drive_file_id, "video-1");
  assert.equal(result.videos[0].nome_do_arquivo, "intro.mp4");
  assert.equal(result.videos[0].pasta_atual, "#P01 - Persona Paulo");
  assert.equal(result.videos[0].google_drive_created_at, "2026-07-01T00:00:00.000Z");
  assert.equal(result.videos[0].status, true);
  assert.deepEqual(result.videos[0].drive_path, ["Conteudos", "Etapa 01", "#P01 - Persona Paulo"]);
  assert.equal(persisted.length, 1);
}

async function testFolderErrorsDoNotStopIndexing() {
  const drive = createFakeDrive(
    {
      root: [
        { id: "good", name: "Fase 2", mimeType: FOLDER_MIME_TYPE },
        { id: "bad", name: "Fase 3", mimeType: FOLDER_MIME_TYPE },
      ],
      good: [{ id: "persona-m", name: "Maria M01", mimeType: FOLDER_MIME_TYPE }],
      "persona-m": [
        {
          id: "video-2",
          name: "aula.mov",
          mimeType: "application/octet-stream",
          fileExtension: "mov",
        },
      ],
    },
    new Set(["bad"])
  );

  const result = await indexGoogleDriveVideos({
    drive,
    rootFolderId: "root",
    logger: {},
  });

  assert.equal(result.indexed_count, 1);
  assert.equal(result.error_count, 1);
  assert.equal(result.errors[0].folder_id, "bad");
  assert.equal(result.videos[0].drive_file_id, "video-2");
  assert.equal(result.videos[0].pasta_atual, "Maria M01");
}

async function testInvalidVideosAreIgnored() {
  assert.equal(isValidVideoFile({ name: "video.mp4", mimeType: "video/mp4" }), true);
  assert.equal(isValidVideoFile({ name: "video.mov", mimeType: "application/octet-stream" }), true);
  assert.equal(isValidVideoFile({ name: "image.png", mimeType: "image/png" }), false);
  assert.equal(isValidVideoFile({ name: "folder", mimeType: FOLDER_MIME_TYPE }), false);
}

async function testIncrementalQueryKeepsFoldersAndFiltersFilesByModifiedTime() {
  const query = buildFolderChildrenQuery("root", {
    modifiedTimeAfter: "2026-07-14T10:00:00.000Z",
    modifiedTimeBefore: "2026-07-14T11:00:00.000Z",
  });

  assert.equal(
    query,
    "'root' in parents and trashed = false and (mimeType = 'application/vnd.google-apps.folder' or (modifiedTime > '2026-07-14T10:00:00.000Z' and modifiedTime <= '2026-07-14T11:00:00.000Z'))"
  );
}

async function testIncrementalIndexingReportsProcessedCountAndPeriod() {
  const seenQueries = [];
  const drive = {
    files: {
      async list(params) {
        seenQueries.push(params.q);
        const folderId = params.q.match(/'([^']+)' in parents/)[1];

        return {
          data: {
            files:
              folderId === "root"
                ? [{ id: "persona-e", name: "#E01", mimeType: FOLDER_MIME_TYPE }]
                : [
                    {
                      id: "video-3",
                      name: "aula.mp4",
                      mimeType: "video/mp4",
                      fileExtension: "mp4",
                      modifiedTime: "2026-07-14T10:30:00.000Z",
                    },
                  ],
          },
        };
      },
    },
  };

  const result = await indexGoogleDriveVideos({
    drive,
    rootFolderId: "root",
    rootFolderName: "Etapa 01",
    modifiedTimeAfter: "2026-07-14T10:00:00.000Z",
    modifiedTimeBefore: "2026-07-14T11:00:00.000Z",
    logger: {},
  });

  assert.equal(result.processed_count, 1);
  assert.equal(result.indexed_count, 1);
  assert.equal(result.modified_time_after, "2026-07-14T10:00:00.000Z");
  assert.equal(result.modified_time_before, "2026-07-14T11:00:00.000Z");
  assert.match(seenQueries[0], /modifiedTime > '2026-07-14T10:00:00.000Z'/);
  assert.match(seenQueries[0], /modifiedTime <= '2026-07-14T11:00:00.000Z'/);
  assert.equal(result.videos[0].modified_time, "2026-07-14T10:30:00.000Z");
}

async function testStartsTranscriptionOnlyForNewVideosWithoutBlockingIndexing() {
  const drive = createFakeDrive({
    root: [{ id: "step-1", name: "Etapa 01", mimeType: FOLDER_MIME_TYPE }],
    "step-1": [{ id: "persona-p", name: "#P01", mimeType: FOLDER_MIME_TYPE }],
    "persona-p": [
      {
        id: "video-new",
        name: "novo.mp4",
        mimeType: "video/mp4",
        fileExtension: "mp4",
      },
      {
        id: "video-existing",
        name: "existente.mp4",
        mimeType: "video/mp4",
        fileExtension: "mp4",
      },
    ],
  });
  const transcriptionCalls = [];

  const result = await indexGoogleDriveVideos({
    drive,
    rootFolderId: "root",
    upsertVideo: async (video) => ({
      created: video.drive_file_id === "video-new",
      video: {
        id: `catalog-${video.drive_file_id}`,
        ...video,
      },
    }),
    transcribeVideo: async (video) => {
      transcriptionCalls.push(video.drive_file_id);
      await new Promise(() => {});
    },
    logger: {},
  });

  await Promise.resolve();

  assert.equal(result.indexed_count, 2);
  assert.deepEqual(transcriptionCalls, ["video-new"]);
}

async function testFollowsShortcutToFolderAndIndexesVideosInside() {
  const drive = createFakeDrive({
    root: [
      {
        id: "shortcut-1",
        name: "Vídeos Razonet",
        mimeType: SHORTCUT_MIME_TYPE,
        shortcutDetails: { targetId: "real-folder-1", targetMimeType: FOLDER_MIME_TYPE },
      },
    ],
    "real-folder-1": [
      {
        id: "video-in-shortcut",
        name: "aula.mp4",
        mimeType: "video/mp4",
        fileExtension: "mp4",
      },
    ],
  });

  const result = await indexGoogleDriveVideos({ drive, rootFolderId: "root", logger: {} });

  assert.equal(result.indexed_count, 1);
  assert.equal(result.error_count, 0);
  assert.equal(result.videos[0].drive_file_id, "video-in-shortcut");
  assert.equal(result.videos[0].pasta_atual, "Vídeos Razonet");
}

async function testFollowsShortcutToVideoFileDirectly() {
  const drive = createFakeDrive(
    {
      root: [
        {
          id: "shortcut-2",
          name: "Aula Atalho",
          mimeType: SHORTCUT_MIME_TYPE,
          shortcutDetails: { targetId: "real-video-1", targetMimeType: "video/mp4" },
        },
      ],
    },
    new Set(),
    {
      "real-video-1": {
        id: "real-video-1",
        name: "aula-real.mp4",
        mimeType: "video/mp4",
        fileExtension: "mp4",
        webViewLink: "https://drive.google.com/file/d/real-video-1/view",
      },
    }
  );

  const result = await indexGoogleDriveVideos({ drive, rootFolderId: "root", logger: {} });

  assert.equal(result.indexed_count, 1);
  assert.equal(result.error_count, 0);
  assert.equal(result.videos[0].drive_file_id, "real-video-1");
  assert.equal(result.videos[0].nome_do_arquivo, "aula-real.mp4");
}

async function testShortcutWithoutTargetIsSkippedNotErrored() {
  const drive = createFakeDrive({
    root: [
      {
        id: "shortcut-3",
        name: "Atalho quebrado",
        mimeType: SHORTCUT_MIME_TYPE,
      },
    ],
  });

  const result = await indexGoogleDriveVideos({ drive, rootFolderId: "root", logger: {} });

  assert.equal(result.indexed_count, 0);
  assert.equal(result.error_count, 0);
  assert.equal(result.skipped[0].reason, "shortcut_without_target");
}

async function main() {
  await testRecursiveIndexingMapsBasicCatalogFields();
  await testFolderErrorsDoNotStopIndexing();
  await testInvalidVideosAreIgnored();
  await testIncrementalQueryKeepsFoldersAndFiltersFilesByModifiedTime();
  await testIncrementalIndexingReportsProcessedCountAndPeriod();
  await testStartsTranscriptionOnlyForNewVideosWithoutBlockingIndexing();
  await testFollowsShortcutToFolderAndIndexesVideosInside();
  await testFollowsShortcutToVideoFileDirectly();
  await testShortcutWithoutTargetIsSkippedNotErrored();

  console.log("google-drive-video-indexer tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
