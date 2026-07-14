const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createGoogleDriveVideoIndexStateStore,
} = require("../src/services/google-drive-video-index-state");

async function testStateStoresLastSuccessfulIndexByRootFolder() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "drive-index-state-"));
  const filePath = path.join(tempDir, "state.json");
  const store = createGoogleDriveVideoIndexStateStore({ filePath });

  assert.equal(await store.getLastSuccessfulIndexAt({ rootFolderId: "root" }), undefined);

  await store.saveSuccessfulIndex({
    rootFolderId: "root",
    rootFolderName: "Conteudos",
    indexedAt: "2026-07-14T10:00:00.000Z",
    completedAt: "2026-07-14T10:03:00.000Z",
    jobId: "job-1",
    processedCount: 2,
    indexedCount: 1,
    skippedCount: 1,
    errorCount: 0,
  });

  assert.equal(
    await store.getLastSuccessfulIndexAt({ rootFolderId: "root" }),
    "2026-07-14T10:00:00.000Z"
  );

  const persistedState = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(persistedState.roots.root.last_completed_at, "2026-07-14T10:03:00.000Z");
  assert.equal(persistedState.roots.root.last_processed_count, 2);
}

async function main() {
  await testStateStoresLastSuccessfulIndexByRootFolder();

  console.log("google-drive-video-index-state tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
