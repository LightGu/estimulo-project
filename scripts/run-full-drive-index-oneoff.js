require("dotenv").config({ quiet: true });

const { createGoogleDriveClient } = require("../src/services/google-drive");
const { indexGoogleDriveVideos } = require("../src/services/google-drive-video-indexer");
const { createDefaultVideoUpsert } = require("../src/queues/google-drive-video-index");
const { createGoogleDriveVideoIndexStateStore } = require("../src/services/google-drive-video-index-state");

async function main() {
  const drive = createGoogleDriveClient();
  const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  const rootFolderName = "root";
  const startedAt = new Date().toISOString();

  console.log(`Iniciando FULL INDEX da pasta raiz ${rootFolderId} as ${startedAt}...`);

  const result = await indexGoogleDriveVideos({
    drive,
    rootFolderId,
    rootFolderName,
    modifiedTimeBefore: startedAt,
    upsertVideo: createDefaultVideoUpsert(),
    logger: console,
  });

  const completedAt = new Date().toISOString();

  const stateStore = createGoogleDriveVideoIndexStateStore();
  await stateStore.saveSuccessfulIndex({
    rootFolderId,
    rootFolderName,
    indexedAt: startedAt,
    completedAt,
    jobId: "manual-full-index",
    processedCount: result.processed_count,
    indexedCount: result.indexed_count,
    skippedCount: result.skipped_count,
    errorCount: result.error_count,
  });

  console.log("\n===== Resultado do Full Index =====");
  console.log(`Arquivos processados (todos, incl. pastas/nao-videos): ${result.processed_count}`);
  console.log(`Videos indexados (criados ou atualizados no catalogo): ${result.indexed_count}`);
  console.log(`Ignorados (nao-video, sem etapa/trilha reconhecida): ${result.skipped_count}`);
  console.log(`Erros: ${result.error_count}`);

  if (result.skipped.length) {
    console.log("\nMotivos de skip (contagem por motivo):");
    const byReason = {};
    result.skipped.forEach((s) => {
      byReason[s.reason] = (byReason[s.reason] || 0) + 1;
    });
    console.log(JSON.stringify(byReason, null, 2));
  }

  if (result.errors.length) {
    console.log("\nErros encontrados:");
    result.errors.forEach((e) => console.log(`  - ${e.file_id || e.folder_id}: ${e.message}`));
  }

  console.log(`\nEstado salvo: proxima indexacao incremental usara ${startedAt} como corte.`);
}

main().catch((error) => {
  console.error("ERRO FATAL:", error);
  process.exitCode = 1;
});
