const assert = require("node:assert/strict");

const {
  createVideoCaptionsService,
  generateCaptionFromTranscript,
  getStartOfTodayInTimeZone,
  normalizeCaptionText,
} = require("../src/services/video-captions.service");

async function testSelectsAndMarksUnusedCaption() {
  const calls = [];
  const service = createVideoCaptionsService({
    repository: {
      async listUnusedTodayByVideo(videoId, todayStart) {
        calls.push({ type: "list", videoId, todayStart: todayStart.toISOString() });

        return [
          {
            id: "caption-1",
            video_id: videoId,
            caption_text: " Legenda nova ",
            ultimo_uso_em: null,
          },
        ];
      },
      async markUsed(id, usedAt) {
        calls.push({ type: "mark", id, usedAt: usedAt.toISOString() });

        return {
          id,
          caption_text: " Legenda nova ",
          ultimo_uso_em: usedAt.toISOString(),
        };
      },
    },
    timeZone: "America/Bahia",
  });

  const selected = await service.selectCaptionForVideo("video-1", {
    now: new Date("2026-07-21T15:00:00.000Z"),
  });

  assert.equal(selected.text, "Legenda nova");
  assert.deepEqual(calls, [
    { type: "list", videoId: "video-1", todayStart: "2026-07-21T03:00:00.000Z" },
    { type: "mark", id: "caption-1", usedAt: "2026-07-21T15:00:00.000Z" },
  ]);
}

async function testReturnsNullWhenNoUnusedCaptionExists() {
  let marked = false;
  let created = false;
  const service = createVideoCaptionsService({
    repository: {
      async listUnusedTodayByVideo() {
        return [];
      },
      async markUsed() {
        marked = true;
      },
      async create() {
        created = true;
      },
    },
  });

  const selected = await service.selectCaptionForVideo("video-1");

  assert.equal(selected, null);
  assert.equal(marked, false);
  assert.equal(created, false);
}

async function testGeneratesStoresAndUsesCaptionWhenAllCaptionsWereUsedToday() {
  const calls = [];
  const downloadedVideo = {
    bytes: Buffer.from("video-bytes"),
    mime_type: "video/mp4",
    name: "aula-01.mp4",
  };
  const service = createVideoCaptionsService({
    aiProviderAdapter: {
      async generateCaption(video, options) {
        calls.push({
          type: "generate",
          videoName: video.name,
          prompt: options.prompt,
        });

        return " Legenda gerada por IA ";
      },
    },
    repository: {
      async listUnusedTodayByVideo(videoId, todayStart) {
        calls.push({ type: "list", videoId, todayStart: todayStart.toISOString() });

        return [];
      },
      async markUsed() {
        calls.push({ type: "mark" });
      },
      async create(payload) {
        calls.push({ type: "create", payload });

        return {
          id: "caption-ai-1",
          ...payload,
        };
      },
    },
    timeZone: "America/Bahia",
  });

  const selected = await service.selectCaptionForVideo("video-1", {
    ai: { prompt: "Crie uma legenda curta" },
    downloadedVideo,
    now: new Date("2026-07-21T15:00:00.000Z"),
  });

  assert.equal(selected.text, "Legenda gerada por IA");
  assert.equal(selected.generated, true);
  assert.equal(selected.caption.id, "caption-ai-1");
  assert.deepEqual(calls, [
    { type: "list", videoId: "video-1", todayStart: "2026-07-21T03:00:00.000Z" },
    { type: "generate", videoName: "aula-01.mp4", prompt: "Crie uma legenda curta" },
    {
      type: "create",
      payload: {
        video_id: "video-1",
        caption_text: "Legenda gerada por IA",
        ultimo_uso_em: "2026-07-21T15:00:00.000Z",
      },
    },
  ]);
}

async function testRejectsCaptionAndGeneratesNewOneFromTranscript() {
  const calls = [];
  const service = createVideoCaptionsService({
    aiProviderAdapter: {
      async generateCaptionFromTranscript(transcript) {
        calls.push({ type: "generateFromTranscript", transcript });

        return "Legenda coerente";
      },
    },
    captionReviewService: {
      async reviewCaption({ caption, transcript }) {
        calls.push({ type: "review", caption, transcript });

        return {
          approved: caption === "Legenda coerente",
          reason: caption === "Legenda coerente" ? "ok" : "fora da transcricao",
        };
      },
    },
    logger: {},
    repository: {
      async listUnusedTodayByVideo() {
        calls.push({ type: "list" });

        return [{ id: "caption-1", caption_text: "Legenda inventada" }];
      },
      async markUsed() {
        calls.push({ type: "mark" });
      },
      async create(payload) {
        calls.push({ type: "create", payload });

        return { id: "caption-2", ...payload };
      },
    },
  });

  const selected = await service.selectCaptionForVideo("video-1", {
    transcript: "Transcricao real do video",
    requireCaptionReview: true,
    now: new Date("2026-07-21T15:00:00.000Z"),
  });

  assert.equal(selected.text, "Legenda coerente");
  assert.equal(selected.generated, true);
  assert.deepEqual(calls, [
    { type: "list" },
    { type: "review", caption: "Legenda inventada", transcript: "Transcricao real do video" },
    { type: "generateFromTranscript", transcript: "Transcricao real do video" },
    { type: "review", caption: "Legenda coerente", transcript: "Transcricao real do video" },
    {
      type: "create",
      payload: {
        video_id: "video-1",
        caption_text: "Legenda coerente",
        ultimo_uso_em: "2026-07-21T15:00:00.000Z",
      },
    },
  ]);
}

async function main() {
  assert.equal(normalizeCaptionText({ caption_text: " Texto " }), "Texto");
  assert.equal(await generateCaptionFromTranscript({
    async generateCaptionFromTranscript(transcript) {
      return `Legenda de ${transcript}`;
    },
  }, "transcricao"), "Legenda de transcricao");
  assert.equal(
    getStartOfTodayInTimeZone(new Date("2026-07-21T15:00:00.000Z"), "America/Bahia").toISOString(),
    "2026-07-21T03:00:00.000Z"
  );

  await testSelectsAndMarksUnusedCaption();
  await testReturnsNullWhenNoUnusedCaptionExists();
  await testGeneratesStoresAndUsesCaptionWhenAllCaptionsWereUsedToday();
  await testRejectsCaptionAndGeneratesNewOneFromTranscript();

  console.log("video-captions-service tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
