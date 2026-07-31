const assert = require("node:assert/strict");

const {
  createVideoCaptionsService,
  findCaptionMetaResponseReason,
  generateCaptionFromTranscript,
  getStartOfTodayInTimeZone,
  normalizeCaptionText,
} = require("../src/services/video-captions.service");

async function testSelectsUnusedCaptionWithoutMarkingUse() {
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
  ]);
}

async function testMarksCaptionUsedOnDemand() {
  const calls = [];
  const service = createVideoCaptionsService({
    repository: {
      async markUsed(id, usedAt) {
        calls.push({ type: "mark", id, usedAt: usedAt.toISOString() });

        return {
          id,
          caption_text: "Legenda nova",
          ultimo_uso_em: usedAt.toISOString(),
        };
      },
    },
  });

  const marked = await service.markCaptionUsed("caption-1", {
    usedAt: new Date("2026-07-21T15:00:00.000Z"),
  });

  assert.equal(marked.ultimo_uso_em, "2026-07-21T15:00:00.000Z");
  assert.deepEqual(calls, [
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
          type: "transcribe",
          videoName: video.name,
          prompt: options.prompt,
        });

        return " Transcricao crua ";
      },
      async generateCaptionFromTranscript(transcript) {
        calls.push({ type: "generateFromTranscript", transcript });

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
    videoCatalogRepository: {
      async update(videoId, payload) {
        calls.push({ type: "persist_transcript", videoId, payload });

        return { id: videoId, ...payload };
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
    { type: "transcribe", videoName: "aula-01.mp4", prompt: "Crie uma legenda curta" },
    { type: "persist_transcript", videoId: "video-1", payload: { transcript: "Transcricao crua" } },
    { type: "generateFromTranscript", transcript: "Transcricao crua" },
    {
      type: "create",
      payload: {
        video_id: "video-1",
        caption_text: "Legenda gerada por IA",
      },
    },
  ]);
}

async function testAcceptsPendingDownloadedVideoForGeneration() {
  const calls = [];
  let finishDownload;
  const downloadedVideoPromise = new Promise((resolve) => {
    finishDownload = () =>
      resolve({
        bytes: Buffer.from("video-bytes"),
        mime_type: "video/mp4",
        name: "aula-01.mp4",
      });
  });
  const service = createVideoCaptionsService({
    aiProviderAdapter: {
      async generateCaption(video) {
        calls.push({ type: "transcribe", videoName: video.name });

        return "Transcricao crua";
      },
      async generateCaptionFromTranscript(transcript) {
        calls.push({ type: "generateFromTranscript", transcript });

        return "Legenda gerada";
      },
    },
    repository: {
      async listUnusedTodayByVideo() {
        calls.push({ type: "list" });

        return [];
      },
      async create(payload) {
        calls.push({ type: "create", payload });

        return { id: "caption-ai-1", ...payload };
      },
    },
    videoCatalogRepository: {
      async update(videoId, payload) {
        calls.push({ type: "persist_transcript", videoId, payload });

        return { id: videoId, ...payload };
      },
    },
  });

  const selecting = service.selectCaptionForVideo("video-1", {
    downloadedVideo: downloadedVideoPromise,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [{ type: "list" }]);

  finishDownload();
  const selected = await selecting;

  assert.equal(selected.text, "Legenda gerada");
  assert.deepEqual(calls, [
    { type: "list" },
    { type: "transcribe", videoName: "aula-01.mp4" },
    { type: "persist_transcript", videoId: "video-1", payload: { transcript: "Transcricao crua" } },
    { type: "generateFromTranscript", transcript: "Transcricao crua" },
    {
      type: "create",
      payload: {
        video_id: "video-1",
        caption_text: "Legenda gerada",
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
      },
    },
  ]);
}

async function testPrefersTranscriptOverDownloadedVideoForCaptionGeneration() {
  const calls = [];
  const service = createVideoCaptionsService({
    aiProviderAdapter: {
      async generateCaption(video) {
        calls.push({ type: "generateFromVideo", videoName: video.name });

        return "Transcricao crua";
      },
      async generateCaptionFromTranscript(transcript) {
        calls.push({ type: "generateFromTranscript", transcript });

        return "Legenda pronta";
      },
    },
    captionReviewService: {
      async reviewCaption({ caption, transcript }) {
        calls.push({ type: "review", caption, transcript });

        return { approved: true, reason: "ok" };
      },
    },
    repository: {
      async listUnusedTodayByVideo() {
        calls.push({ type: "list" });

        return [];
      },
      async create(payload) {
        calls.push({ type: "create", payload });

        return { id: "caption-1", ...payload };
      },
    },
  });

  const selected = await service.selectCaptionForVideo("video-1", {
    downloadedVideo: {
      bytes: Buffer.from("video-bytes"),
      mime_type: "video/mp4",
      name: "aula-01.mp4",
    },
    requireCaptionReview: true,
    transcript: "Transcricao real do video",
  });

  assert.equal(selected.text, "Legenda pronta");
  assert.deepEqual(calls, [
    { type: "list" },
    { type: "generateFromTranscript", transcript: "Transcricao real do video" },
    { type: "review", caption: "Legenda pronta", transcript: "Transcricao real do video" },
    {
      type: "create",
      payload: {
        video_id: "video-1",
        caption_text: "Legenda pronta",
      },
    },
  ]);
}

async function testRetriesGeneratedCaptionWhenFirstCandidateIsRejected() {
  const generatedTexts = ["Legenda incoerente", "Legenda aprovada"];
  const reviews = [];
  const service = createVideoCaptionsService({
    aiProviderAdapter: {
      async generateCaptionFromTranscript() {
        return generatedTexts.shift();
      },
    },
    captionReviewService: {
      async reviewCaption({ caption }) {
        reviews.push(caption);
        return { approved: caption === "Legenda aprovada", reason: "revisao" };
      },
    },
    repository: {
      async listUnusedTodayByVideo() {
        return [];
      },
      async create(payload) {
        return { id: "caption-approved", ...payload };
      },
    },
  });

  const selected = await service.selectCaptionForVideo("video-1", {
    transcript: "Transcricao real do video",
    requireCaptionReview: true,
  });

  assert.equal(selected.text, "Legenda aprovada");
  assert.deepEqual(reviews, ["Legenda incoerente", "Legenda aprovada"]);
}

// Regressao do defeito de producao: o prompt de geracao mandava o modelo aguardar
// o comando do usuario, o modelo respondeu perguntando qual modo usar e essa
// pergunta foi persistida e enviada como legenda.
async function testRejectsMetaResponseAndRetriesUntilRealCaption() {
  const responses = [
    "Olá, empreendedor! Como você prefere receber essa mensagem baseada na transcrição da Carol Bartoleto? Escolha o modo desejado: 1 **Modo 1 (Divulgação, Eventos e Pesquisas)** 2 **Modo 2 (Educação e Conteúdo Profundo)** Basta me dizer qual o modo!",
    "🚨 *Legenda real gerada a partir da transcricao*",
  ];
  const created = [];
  const warnings = [];
  const service = createVideoCaptionsService({
    repository: {
      async listUnusedTodayByVideo() {
        return [];
      },
      async create(payload) {
        created.push(payload);

        return { id: "caption-generated", ...payload };
      },
    },
    videoCatalogRepository: {
      async update() {
        return null;
      },
    },
    aiProviderAdapter: {
      async generateCaptionFromTranscript() {
        return responses.shift();
      },
    },
    captionReviewService: {
      async reviewCaption() {
        return { approved: true, reason: "Legenda aprovada" };
      },
    },
    logger: {
      warn(message) {
        warnings.push(JSON.parse(message));
      },
    },
  });

  const selected = await service.selectCaptionForVideo("video-1", {
    transcript: "Transcricao real do video",
  });

  assert.equal(selected.text, "🚨 *Legenda real gerada a partir da transcricao*");
  assert.equal(created.length, 1, "a pergunta nao deve ser persistida como legenda");
  assert.equal(created[0].caption_text, "🚨 *Legenda real gerada a partir da transcricao*");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].event, "caption_generation.meta_response_rejected");
}

async function testReturnsNullWhenEveryAttemptIsAMetaResponse() {
  const created = [];
  const service = createVideoCaptionsService({
    repository: {
      async listUnusedTodayByVideo() {
        return [];
      },
      async create(payload) {
        created.push(payload);

        return { id: "caption-generated", ...payload };
      },
    },
    videoCatalogRepository: {
      async update() {
        return null;
      },
    },
    aiProviderAdapter: {
      async generateCaptionFromTranscript() {
        return "Escolha o modo desejado: Modo 1 ou Modo 2?";
      },
    },
    captionReviewService: {
      async reviewCaption() {
        return { approved: true, reason: "Legenda aprovada" };
      },
    },
    logger: { warn() {} },
  });

  const selected = await service.selectCaptionForVideo("video-1", {
    transcript: "Transcricao real do video",
  });

  assert.equal(selected, null, "sem legenda valida o envio nao deve receber a pergunta");
  assert.equal(created.length, 0);
}

async function main() {
  assert.equal(normalizeCaptionText({ caption_text: " Texto " }), "Texto");

  // Perguntas/menus devem ser barrados; legendas legitimas devem passar.
  assert.ok(findCaptionMetaResponseReason("Escolha o modo desejado: 1 ou 2"));
  assert.ok(findCaptionMetaResponseReason("Como você prefere receber essa mensagem?"));
  assert.ok(findCaptionMetaResponseReason("**Modo 1** (Divulgação) ou **Modo 2** (Educação)?"));
  assert.equal(findCaptionMetaResponseReason("🚨 *Pessoal, precisamos da ajuda de vocês!*"), null);
  assert.equal(
    findCaptionMetaResponseReason("📌 *Seu negócio não cresce olhando apenas para dentro dele.*"),
    null
  );
  assert.equal(findCaptionMetaResponseReason(""), null);
  assert.equal(await generateCaptionFromTranscript({
    async generateCaptionFromTranscript(transcript) {
      return `Legenda de ${transcript}`;
    },
  }, "transcricao"), "Legenda de transcricao");
  assert.equal(
    getStartOfTodayInTimeZone(new Date("2026-07-21T15:00:00.000Z"), "America/Bahia").toISOString(),
    "2026-07-21T03:00:00.000Z"
  );

  await testSelectsUnusedCaptionWithoutMarkingUse();
  await testMarksCaptionUsedOnDemand();
  await testReturnsNullWhenNoUnusedCaptionExists();
  await testGeneratesStoresAndUsesCaptionWhenAllCaptionsWereUsedToday();
  await testAcceptsPendingDownloadedVideoForGeneration();
  await testRejectsCaptionAndGeneratesNewOneFromTranscript();
  await testPrefersTranscriptOverDownloadedVideoForCaptionGeneration();
  await testRetriesGeneratedCaptionWhenFirstCandidateIsRejected();
  await testRejectsMetaResponseAndRetriesUntilRealCaption();
  await testReturnsNullWhenEveryAttemptIsAMetaResponse();

  console.log("video-captions-service tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
