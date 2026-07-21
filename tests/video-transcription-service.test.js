const assert = require("node:assert/strict");

const {
  createVideoTranscriptionService,
  extractGeminiText,
  normalizeForce,
  resolveGeminiModelPath,
} = require("../src/services/video-transcription.service");

function createRepository(initialVideos) {
  const videos = initialVideos.map((video) => ({ ...video }));
  const updates = [];

  return {
    updates,
    async findByDriveFileId(driveFileId) {
      return videos.find((video) => video.drive_file_id === driveFileId) || null;
    },
    async findById(id) {
      return videos.find((video) => video.id === id) || null;
    },
    async update(id, payload) {
      updates.push({ id, payload });
      const index = videos.findIndex((video) => video.id === id);
      videos[index] = { ...videos[index], ...payload };
      return videos[index];
    },
  };
}

async function testTranscribesDriveVideoAndPersistsTranscript() {
  const repository = createRepository([
    {
      id: "video-1",
      drive_file_id: "drive-1",
      name: "aula.mp4",
    },
  ]);
  const downloads = [];
  const transcriptions = [];
  const service = createVideoTranscriptionService({
    repository,
    downloadFromDrive: async ({ videoCatalogRecord }) => {
      downloads.push(videoCatalogRecord.drive_file_id);
      return {
        bytes: Buffer.from("video"),
        drive_file_id: videoCatalogRecord.drive_file_id,
        mime_type: "video/mp4",
        name: "aula.mp4",
      };
    },
    transcriber: {
      async transcribe(downloadedVideo) {
        transcriptions.push(downloadedVideo.drive_file_id);
        return "Transcricao gerada";
      },
    },
  });

  const result = await service.transcribeByDriveFileId("drive-1");

  assert.equal(result.skipped, false);
  assert.equal(result.transcript, "Transcricao gerada");
  assert.deepEqual(downloads, ["drive-1"]);
  assert.deepEqual(transcriptions, ["drive-1"]);
  assert.deepEqual(repository.updates, [{ id: "video-1", payload: { transcript: "Transcricao gerada" } }]);
}

async function testSkipsVideoWithExistingTranscript() {
  const repository = createRepository([
    {
      id: "video-1",
      drive_file_id: "drive-1",
      transcript: "Transcricao existente",
    },
  ]);
  const service = createVideoTranscriptionService({
    repository,
    downloadFromDrive: async () => {
      throw new Error("nao deveria baixar novamente");
    },
    transcriber: {
      async transcribe() {
        throw new Error("nao deveria transcrever novamente");
      },
    },
  });

  const result = await service.transcribeByDriveFileId("drive-1");

  assert.equal(result.skipped, true);
  assert.equal(result.transcript, "Transcricao existente");
  assert.deepEqual(repository.updates, []);
}

async function testForceRetranscribesVideoWithExistingTranscript() {
  const repository = createRepository([
    {
      id: "video-1",
      drive_file_id: "drive-1",
      transcript: "Transcricao antiga",
    },
  ]);
  let downloads = 0;
  const service = createVideoTranscriptionService({
    repository,
    downloadFromDrive: async () => {
      downloads += 1;
      return {
        bytes: Buffer.from("video"),
        drive_file_id: "drive-1",
        mime_type: "video/mp4",
        name: "aula.mp4",
      };
    },
    transcriber: {
      async transcribe() {
        return "Transcricao nova";
      },
    },
  });

  const result = await service.transcribeByDriveFileId("drive-1", { force: "true" });

  assert.equal(result.skipped, false);
  assert.equal(result.transcript, "Transcricao nova");
  assert.equal(downloads, 1);
  assert.deepEqual(repository.updates, [{ id: "video-1", payload: { transcript: "Transcricao nova" } }]);
}

async function testRejectsEmptyTranscript() {
  const repository = createRepository([
    {
      id: "video-1",
      drive_file_id: "drive-1",
    },
  ]);
  const service = createVideoTranscriptionService({
    repository,
    downloadFromDrive: async () => ({
      bytes: Buffer.from("video"),
      drive_file_id: "drive-1",
      mime_type: "video/mp4",
      name: "aula.mp4",
    }),
    transcriber: {
      async transcribe() {
        return " ";
      },
    },
  });

  await assert.rejects(() => service.transcribeByDriveFileId("drive-1"), /Transcricao gerada esta vazia/);
}

async function main() {
  assert.equal(normalizeForce(true), true);
  assert.equal(normalizeForce("sim"), true);
  assert.equal(normalizeForce("false"), false);
  assert.equal(resolveGeminiModelPath("gemini-1.5-flash"), "models/gemini-1.5-flash");
  assert.equal(resolveGeminiModelPath("models/gemini-1.5-flash"), "models/gemini-1.5-flash");
  assert.equal(
    extractGeminiText({
      candidates: [
        {
          content: {
            parts: [{ text: "Linha 1" }, { text: "Linha 2" }],
          },
        },
      ],
    }),
    "Linha 1\nLinha 2"
  );

  await testTranscribesDriveVideoAndPersistsTranscript();
  await testSkipsVideoWithExistingTranscript();
  await testForceRetranscribesVideoWithExistingTranscript();
  await testRejectsEmptyTranscript();

  console.log("video-transcription-service tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
