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

  const adapter = new GeminiAdapter({ apiKey: "test-key", fetch: fetchImplementation });
  const text = await adapter.generateCaption(createDownloadedVideo());

  assert.equal(text, "Transcricao gerada");
  assert.equal(fetchImplementation.calls.length, 4);
}

async function testGenerateCaptionDeletesFileEvenWhenGenerateContentFails() {
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
    async (url, init) => {
      assert.equal(init.method, "DELETE");
      assert.match(url, /files\/xyz/);
      return jsonResponse({});
    },
  ]);

  const adapter = new GeminiAdapter({ apiKey: "test-key", fetch: fetchImplementation });

  await assert.rejects(() => adapter.generateCaption(createDownloadedVideo()), /Falha ao gerar legenda com Gemini/);
  assert.equal(fetchImplementation.calls.length, 4);
  assert.equal(fetchImplementation.calls[3].init.method, "DELETE");
}

async function testGenerateCaptionDeletesFileEvenWhenUploadQuotaExceeded() {
  const fetchImplementation = createFetchSequence([
    async () =>
      jsonResponse(
        { error: { message: "Quota exceeded for metric: generativelanguage.googleapis.com/file_storage_bytes" } },
        { ok: false, status: 429, statusText: "Too Many Requests" }
      ),
  ]);

  const adapter = new GeminiAdapter({ apiKey: "test-key", fetch: fetchImplementation });

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

    const adapter = new GeminiAdapter({ apiKey: "test-key", fetch: fetchImplementation, model: "gemini-3.5-flash" });
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
  await testGenerateCaptionDeletesFileEvenWhenGenerateContentFails();
  await testGenerateCaptionDeletesFileEvenWhenUploadQuotaExceeded();
  await testGenerateCaptionFallsBackWhenModelOverloaded();
  await testGenerateTextFallsBackWhenQuotaExceeded();

  console.log("gemini-adapter tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
