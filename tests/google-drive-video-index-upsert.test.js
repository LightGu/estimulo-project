const assert = require("node:assert/strict");

const { closeQueueInfrastructure } = require("../src/queues/bullmq");
const { createDefaultVideoUpsert } = require("../src/queues/google-drive-video-index");

function createFakeRepository(initialRows) {
  const rows = new Map(initialRows.map((row) => [row.id, { ...row }]));
  let nextId = 1;

  return {
    async findByDriveFileId(driveFileId) {
      return [...rows.values()].find((row) => row.drive_file_id === driveFileId) || null;
    },
    async findOrphanByNomeDoArquivo(nomeDoArquivo) {
      const matches = [...rows.values()].filter((row) => !row.drive_file_id && row.nome_do_arquivo === nomeDoArquivo);
      return matches.length === 1 ? matches[0] : null;
    },
    async findAll() {
      return [...rows.values()];
    },
    async update(id, payload) {
      const updated = { ...rows.get(id), ...payload };
      rows.set(id, updated);
      return updated;
    },
    async create(payload) {
      const created = { id: `new-${nextId++}`, ...payload };
      rows.set(created.id, created);
      return created;
    },
    _rows: rows,
  };
}

async function testMatchesExistingRowByDriveFileId() {
  const repository = createFakeRepository([
    { id: "video-1", drive_file_id: "drive-1", nome_do_arquivo: "aula.mp4", status: true },
  ]);
  const upsertVideo = createDefaultVideoUpsert(repository);

  const result = await upsertVideo({ drive_file_id: "drive-1", nome_do_arquivo: "aula.mp4" });

  assert.equal(result.created, false);
  assert.equal(result.video.id, "video-1");
  assert.equal(repository._rows.size, 1);
}

async function testFallsBackToOrphanRowWithSameNameWhenDriveFileIdIsNew() {
  const repository = createFakeRepository([
    {
      id: "orphan-1",
      drive_file_id: null,
      link_video: null,
      nome_do_arquivo: "aula.mp4",
      status: false,
    },
  ]);
  const upsertVideo = createDefaultVideoUpsert(repository);

  const result = await upsertVideo({
    drive_file_id: "drive-new",
    nome_do_arquivo: "aula.mp4",
    web_view_link: "https://drive.google.com/file/d/drive-new/view",
    status: true,
  });

  assert.equal(result.created, false);
  assert.equal(result.video.id, "orphan-1");
  assert.equal(result.video.drive_file_id, "drive-new");
  assert.equal(result.video.link_video, "https://drive.google.com/file/d/drive-new/view");
  assert.equal(result.video.status, true);
  assert.equal(repository._rows.size, 1);
}

async function testCreatesNewRowWhenNoDriveFileIdOrOrphanMatch() {
  const repository = createFakeRepository([]);
  const upsertVideo = createDefaultVideoUpsert(repository);

  const result = await upsertVideo({ drive_file_id: "drive-new", nome_do_arquivo: "aula.mp4" });

  assert.equal(result.created, true);
  assert.equal(repository._rows.size, 1);
}

async function testDoesNotGuessWhenMultipleOrphansShareTheSameName() {
  const repository = createFakeRepository([
    { id: "orphan-1", drive_file_id: null, nome_do_arquivo: "aula.mp4", status: false },
    { id: "orphan-2", drive_file_id: null, nome_do_arquivo: "aula.mp4", status: false },
  ]);
  const upsertVideo = createDefaultVideoUpsert(repository);

  const result = await upsertVideo({ drive_file_id: "drive-new", nome_do_arquivo: "aula.mp4" });

  assert.equal(result.created, true);
  assert.equal(repository._rows.size, 3);
}

async function main() {
  await testMatchesExistingRowByDriveFileId();
  await testFallsBackToOrphanRowWithSameNameWhenDriveFileIdIsNew();
  await testCreatesNewRowWhenNoDriveFileIdOrOrphanMatch();
  await testDoesNotGuessWhenMultipleOrphansShareTheSameName();

  console.log("google-drive-video-index-upsert tests OK");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueueInfrastructure();
  });
