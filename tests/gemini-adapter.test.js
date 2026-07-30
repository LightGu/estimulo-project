const assert = require("node:assert/strict");

const { GeminiAdapter } = require("../src/services/ai/gemini-adapter");

function jsonResponse(body, init = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    headers: {
      get: (name) => (init.headers ? init.headers[name] : undefined),
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function createDownloadedVideo() {
  return {
    bytes: Buffer.from("video-bytes"),
    mime_type: "video/mp4",
    name: "aula-01.mp4",
  };
}

// Extracao real de audio depende do ffmpeg e e coberta em
// tests/video-audio-extraction.test.js; aqui basta um dublê que registra as
// chamadas e devolve o audio no mesmo formato do downloadFromDrive.
function createAudioExtractor() {
  const calls = [];

  const extractAudio = async (downloadedVideo) => {
    calls.push(downloadedVideo);

    return {
      ...downloadedVideo,
      bytes: Buffer.from("audio-bytes"),
      mime_type: "audio/mp3",
      name: "aula-01.mp3",
    };
  };

  extractAudio.calls = calls;

  return extractAudio;
}

function createFetchSequence(handlers) {
  const calls = [];

  const fetchImplementation = async (url, init) => {
    calls.push({ url, init });
    const handler = handlers[calls.length - 1];

    if (!handler) {
      throw new Error(`Chamada de fetch inesperada: ${url}`);
    }

    return handler(url, init);
  };

  fetchImplementation.calls = calls;

  return fetchImplementation;
}

async function testGenerateCaptionDeletesFileAfterSuccess() {
  const fetchImplementation = createFetchSequence([
    // upload start
    async () =>
      jsonResponse(
        {},
        { headers: { "x-goog-upload-url": "https://upload.example/resumable" } }
      ),
    // upload bytes
    async () => jsonResponse({ file: { name: "files/abc", uri: "https://files.example/abc", state: "ACTIVE" } }),
    // generateContent
    async () =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "Transcricao gerada" }] } }],
      }),
    // delete
    async (url, init) => {
      assert.equal(init.method, "DELETE");
      assert.match(url, /files\/abc/);
      return jsonResponse({});
    },
  ]);

  const adapter = new GeminiAdapter({
    apiKey: "test-key",
    extractAudio: createAudioExtractor(),
    fetch: fetchImplementation,
  });
  const text = await adapter.generateCaption(createDownloadedVideo());

  assert.equal(text, "Transcricao gerada");
  assert.equal(fetchImplementation.calls.length, 4);
}

async function testGenerateCaptionUploadsOnlyTheAudioTrack() {
  // O agente de transcricao nao deve mais enviar o video para o Gemini: apenas o
  // audio extraido dele, que e o suficiente para transcrever e custa uma fracao
  // dos tokens/bytes do video completo.
  const fetchImplementation = createFetchSequence([
    async () => jsonResponse({}, { headers: { "x-goog-upload-url": "https://upload.example/resumable" } }),
    async () => jsonResponse({ file: { name: "files/audio", uri: "https://files.example/audio", state: "ACTIVE" } }),
    async () => jsonResponse({ candidates: [{ content: { parts: [{ text: "Transcricao do audio" }] } }] }),
    async () => jsonResponse({}),
  ]);
  const extractAudio = createAudioExtractor();
  const adapter = new GeminiAdapter({ apiKey: "test-key", extractAudio, fetch: fetchImplementation });
  const downloadedVideo = createDownloadedVideo();
  const text = await adapter.generateCaption(downloadedVideo);
  const [uploadStart, uploadBytes, generateContent] = fetchImplementation.calls;
  const generateContentBody = JSON.parse(generateContent.init.body);

  assert.equal(text, "Transcricao do audio");
  assert.equal(extractAudio.calls.length, 1);
  assert.equal(extractAudio.calls[0], downloadedVideo);
  assert.equal(uploadStart.init.headers["X-Goog-Upload-Header-Content-Type"], "audio/mp3");
  assert.equal(uploadStart.init.headers["X-Goog-Upload-Header-Content-Length"], "11");
  assert.equal(JSON.parse(uploadStart.init.body).file.display_name, "aula-01.mp3");
  assert.equal(uploadBytes.init.headers["Content-Type"], "audio/mp3");
  assert.equal(uploadBytes.init.body.toString(), "audio-bytes");
  assert.equal(generateContentBody.contents[0].parts[0].file_data.mime_type, "audio/mp3");
}

async function testGenerateCaptionCanStillSendVideoWhenAudioOnlyIsDisabled() {
  // Escape hatch (audioOnly: false / TRANSCRIPTION_AUDIO_ONLY=false) para casos em
  // que o ffmpeg nao esteja disponivel no ambiente.
  const fetchImplementation = createFetchSequence([
    async () => jsonResponse({}, { headers: { "x-goog-upload-url": "https://upload.example/resumable" } }),
    async () => jsonResponse({ file: { name: "files/video", uri: "https://files.example/video", state: "ACTIVE" } }),
    async () => jsonResponse({ candidates: [{ content: { parts: [{ text: "Transcricao do video" }] } }] }),
    async () => jsonResponse({}),
  ]);
  const extractAudio = createAudioExtractor();
  const adapter = new GeminiAdapter({
    apiKey: "test-key",
    audioOnly: false,
    extractAudio,
    fetch: fetchImplementation,
  });
  const text = await adapter.generateCaption(createDownloadedVideo());
  const generateContentBody = JSON.parse(fetchImplementation.calls[2].init.body);

  assert.equal(text, "Transcricao do video");
  assert.equal(extractAudio.calls.length, 0);
  assert.equal(fetchImplementation.calls[0].init.headers["X-Goog-Upload-Header-Content-Type"], "video/mp4");
  assert.equal(generateContentBody.contents[0].parts[0].file_data.mime_type, "video/mp4");
}

async function testGenerateCaptionDeletesFileEvenWhenGenerateContentFails() {
  // Um unico modelo configurado ainda percorre a rede de seguranca
  // (gemini-flash-latest / gemini-flash-lite-latest) antes de desistir, mas o
  // arquivo enviado para a Files API precisa ser deletado de qualquer forma.
  const fetchImplementation = createFetchSequence([
    async () =>
      jsonResponse(
        {},
        { headers: { "x-goog-upload-url": "https://upload.example/resumable" } }
      ),
    async () => jsonResponse({ file: { name: "files/xyz", uri: "https://files.example/xyz", state: "ACTIVE" } }),
    async () =>
      jsonResponse(
        { error: { message: "Erro interno" } },
        { ok: false, status: 500, statusText: "Internal Server Error" }
      ),
    async () =>
      jsonResponse(
        { error: { message: "Erro interno" } },
        { ok: false, status: 500, statusText: "Internal Server Error" }
      ),
    async (url, init) => {
      assert.equal(init.method, "DELETE");
      assert.match(url, /files\/xyz/);
      return jsonResponse({});
    },
  ]);

  const adapter = new GeminiAdapter({
    apiKey: "test-key",
    extractAudio: createAudioExtractor(),
    fetch: fetchImplementation,
  });

  await assert.rejects(() => adapter.generateCaption(createDownloadedVideo()), /Falha ao gerar legenda com Gemini/);
  assert.equal(fetchImplementation.calls.length, 5);
  assert.equal(fetchImplementation.calls[4].init.method, "DELETE");
}

// Regressao do bug reportado em producao: a legenda e a transcricao ja estavam
// prontas, mas o envio falhava com "Falha ao gerar texto com Gemini (modelo
// gemini-2.5-flash-lite)" porque TODOS os modelos salvos em settings.ai_agents
// tinham sido retirados pelo Google. A cascata precisa terminar na rede de
// seguranca ("-latest") mesmo quando os modelos vem da configuracao.
async function testGenerateTextFallsBackToSafetyNetWhenConfiguredModelsAreRetired() {
  const retiredResponse = () =>
    jsonResponse(
      {
        error: {
          message:
            "This model models/gemini-2.5-flash-lite is no longer available to new users. Please update your code to use a newer model.",
        },
      },
      { ok: false, status: 404, statusText: "Not Found" }
    );
  const fetchImplementation = createFetchSequence([
    retiredResponse,
    retiredResponse,
    async (url) => {
      assert.match(url, /models\/gemini-flash-latest/);
      return jsonResponse({ candidates: [{ content: { parts: [{ text: "Legenda revisada" }] } }] });
    },
  ]);

  const adapter = new GeminiAdapter({
    apiKey: "test-key",
    fetch: fetchImplementation,
    models: ["gemini-2.5-flash", "gemini-2.5-flash-lite"],
  });
  const text = await adapter.generateText("revise a legenda");

  assert.equal(text, "Legenda revisada");
  assert.equal(fetchImplementation.calls.length, 3);
}

// Modelo retirado nunca volta: depois do primeiro 404 ele e memorizado e as
// chamadas seguintes nao gastam mais uma requisicao nele.
async function testRetiredModelIsSkippedOnSubsequentCalls() {
  const fetchImplementation = createFetchSequence([
    async (url) => {
      assert.match(url, /models\/gemini-flash-latest/);
      return jsonResponse({ candidates: [{ content: { parts: [{ text: "Segunda legenda" }] } }] });
    },
  ]);

  const adapter = new GeminiAdapter({
    apiKey: "test-key",
    fetch: fetchImplementation,
    models: ["gemini-2.5-flash", "gemini-2.5-flash-lite"],
  });
  const text = await adapter.generateText("revise a legenda de novo");

  assert.equal(text, "Segunda legenda");
  assert.equal(fetchImplementation.calls.length, 1);
}

async function testGenerateCaptionDeletesFileEvenWhenUploadQuotaExceeded() {
  const fetchImplementation = createFetchSequence([
    async () =>
      jsonResponse(
        { error: { message: "Quota exceeded for metric: generativelanguage.googleapis.com/file_storage_bytes" } },
        { ok: false, status: 429, statusText: "Too Many Requests" }
      ),
  ]);

  const adapter = new GeminiAdapter({
    apiKey: "test-key",
    extractAudio: createAudioExtractor(),
    fetch: fetchImplementation,
  });

  await assert.rejects(() => adapter.generateCaption(createDownloadedVideo()), /Quota exceeded/);
  // Upload nunca completou (sem file.uri), entao nao ha arquivo para deletar.
  assert.equal(fetchImplementation.calls.length, 1);
}

async function testGenerateCaptionFallsBackWhenModelOverloaded() {
  // Erro "high demand" (modelo sobrecarregado, status 503) deve ser tratado como
  // skippable e acionar o proximo modelo da cascata de fallback, em vez de falhar.
  const previousFallbacks = process.env.GEMINI_TRANSCRIPTION_MODEL_FALLBACKS;
  process.env.GEMINI_TRANSCRIPTION_MODEL_FALLBACKS = "gemini-flash-latest";

  try {
    const fetchImplementation = createFetchSequence([
      // upload start
      async () =>
        jsonResponse({}, { headers: { "x-goog-upload-url": "https://upload.example/resumable" } }),
      // upload bytes
      async () => jsonResponse({ file: { name: "files/hd", uri: "https://files.example/hd", state: "ACTIVE" } }),
      // generateContent no primeiro modelo -> sobrecarregado
      async () =>
        jsonResponse(
          { error: { message: "This model is currently experiencing high demand. Please try again later." } },
          { ok: false, status: 503, statusText: "Service Unavailable" }
        ),
      // generateContent no modelo de fallback -> sucesso
      async () =>
        jsonResponse({
          candidates: [{ content: { parts: [{ text: "Transcricao via fallback" }] } }],
        }),
      // delete
      async (url, init) => {
        assert.equal(init.method, "DELETE");
        return jsonResponse({});
      },
    ]);

    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      extractAudio: createAudioExtractor(),
      fetch: fetchImplementation,
      model: "gemini-3.5-flash",
    });
    const text = await adapter.generateCaption(createDownloadedVideo());

    assert.equal(text, "Transcricao via fallback");
    // upload + wait + generate(fail) + generate(fallback ok) + delete
    assert.equal(fetchImplementation.calls.length, 5);
  } finally {
    if (previousFallbacks === undefined) {
      delete process.env.GEMINI_TRANSCRIPTION_MODEL_FALLBACKS;
    } else {
      process.env.GEMINI_TRANSCRIPTION_MODEL_FALLBACKS = previousFallbacks;
    }
  }
}

async function testGenerateTextFallsBackWhenQuotaExceeded() {
  // Reproduz o erro reportado em producao: GEMINI_TEXT_MODEL (usado para gerar o
  // texto da legenda a partir da transcricao) estourou a cota do free tier. Antes
  // desse fix generateText nao tinha cascata de fallback, entao o dispatch falhava
  // em vez de cair para o proximo modelo configurado em GEMINI_TEXT_MODEL_FALLBACKS.
  const previousFallbacks = process.env.GEMINI_TEXT_MODEL_FALLBACKS;
  process.env.GEMINI_TEXT_MODEL_FALLBACKS = "gemini-flash-latest";

  try {
    const fetchImplementation = createFetchSequence([
      async () =>
        jsonResponse(
          {
            error: {
              message:
                "You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash",
            },
          },
          { ok: false, status: 429, statusText: "Too Many Requests" }
        ),
      async () =>
        jsonResponse({
          candidates: [{ content: { parts: [{ text: "Legenda gerada pelo modelo de fallback" }] } }],
        }),
    ]);

    const adapter = new GeminiAdapter({ apiKey: "test-key", fetch: fetchImplementation, model: "gemini-3.6-flash" });
    const text = await adapter.generateText("gere a legenda");

    assert.equal(text, "Legenda gerada pelo modelo de fallback");
    assert.equal(fetchImplementation.calls.length, 2);
  } finally {
    if (previousFallbacks === undefined) {
      delete process.env.GEMINI_TEXT_MODEL_FALLBACKS;
    } else {
      process.env.GEMINI_TEXT_MODEL_FALLBACKS = previousFallbacks;
    }
  }
}

async function main() {
  await testGenerateCaptionDeletesFileAfterSuccess();
  await testGenerateCaptionUploadsOnlyTheAudioTrack();
  await testGenerateCaptionCanStillSendVideoWhenAudioOnlyIsDisabled();
  await testGenerateCaptionDeletesFileEvenWhenGenerateContentFails();
  await testGenerateCaptionDeletesFileEvenWhenUploadQuotaExceeded();
  await testGenerateCaptionFallsBackWhenModelOverloaded();
  await testGenerateTextFallsBackWhenQuotaExceeded();
  // Ordem importa: o memo de modelos retirados e por processo, entao o teste do
  // skip precisa rodar depois do que provoca o 404.
  await testGenerateTextFallsBackToSafetyNetWhenConfiguredModelsAreRetired();
  await testRetiredModelIsSkippedOnSubsequentCalls();

  console.log("gemini-adapter tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
