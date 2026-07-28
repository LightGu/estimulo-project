const assert = require("node:assert/strict");

const {
  createVideoTranscriptionService,
  extractGeminiText,
  normalizeForce,
  resolveGeminiModelPath,
} = require("../src/services/video-transcription.service");
const {
  GeminiAdapter,
  OpenAIAdapter,
  createAIProviderAdapter,
  normalizeAIProvider,
} = require("../src/services/ai");
const { getAIProviderConfig } = require("../src/config/ai");
const { extractOpenAITranscriptionText } = require("../src/services/ai/openai-adapter");

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

async function testUsesAIProviderAdapterGenerateCaption() {
  const repository = createRepository([
    {
      id: "video-1",
      drive_file_id: "drive-1",
    },
  ]);
  const calls = [];
  const service = createVideoTranscriptionService({
    repository,
    downloadFromDrive: async () => ({
      bytes: Buffer.from("video"),
      drive_file_id: "drive-1",
      mime_type: "video/mp4",
      name: "aula.mp4",
    }),
    aiProviderAdapter: {
      async generateCaption(downloadedVideo) {
        calls.push(downloadedVideo.name);
        return "Legenda via adapter";
      },
    },
  });

  const result = await service.transcribeByDriveFileId("drive-1");

  assert.equal(result.transcript, "Legenda via adapter");
  assert.deepEqual(calls, ["aula.mp4"]);
  assert.deepEqual(repository.updates, [{ id: "video-1", payload: { transcript: "Legenda via adapter" } }]);
}

function testAIProviderFactorySelectsConfiguredProvider() {
  const originalProvider = process.env.AI_PROVIDER;

  process.env.AI_PROVIDER = "openai";
  assert.ok(createAIProviderAdapter() instanceof OpenAIAdapter);

  process.env.AI_PROVIDER = "gemini";
  assert.ok(createAIProviderAdapter() instanceof GeminiAdapter);

  process.env.AI_PROVIDER = "gpt";
  assert.ok(createAIProviderAdapter() instanceof OpenAIAdapter);
  assert.equal(getAIProviderConfig().provider, "openai");

  if (originalProvider === undefined) {
    delete process.env.AI_PROVIDER;
  } else {
    process.env.AI_PROVIDER = originalProvider;
  }

  assert.equal(normalizeAIProvider("OPEN_AI"), "openai");
  assert.equal(normalizeAIProvider("GOOGLE_GEMINI"), "gemini");
}

async function testOpenAIAdapterGeneratesCaptionWithMultipartRequest() {
  const requests = [];
  const adapter = new OpenAIAdapter({
    apiKey: "openai-key",
    baseUrl: "https://api.openai.test",
    fetch: async (url, options) => {
      requests.push({ url, options });

      assert.equal(url, "https://api.openai.test/v1/audio/transcriptions");
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, "Bearer openai-key");
      assert.equal(options.body.get("model"), "test-transcribe");
      assert.equal(options.body.get("prompt"), "Prompt teste");
      assert.equal(options.body.get("response_format"), "json");
      assert.ok(options.body.get("file"));

      return {
        ok: true,
        text: async () => JSON.stringify({ text: "Legenda OpenAI" }),
      };
    },
    model: "test-transcribe",
  });

  const caption = await adapter.generateCaption(
    {
      bytes: Buffer.from("video"),
      drive_file_id: "drive-1",
      mime_type: "video/mp4",
      name: "aula.mp4",
    },
    { prompt: "Prompt teste" }
  );

  assert.equal(caption, "Legenda OpenAI");
  assert.equal(requests.length, 1);
  assert.equal(extractOpenAITranscriptionText({ text: " Texto " }), "Texto");
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
  await testUsesAIProviderAdapterGenerateCaption();
  testAIProviderFactorySelectsConfiguredProvider();
  await testOpenAIAdapterGeneratesCaptionWithMultipartRequest();

  console.log("video-transcription-service tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
