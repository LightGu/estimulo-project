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

async function main() {
  await testGenerateCaptionDeletesFileAfterSuccess();
  await testGenerateCaptionDeletesFileEvenWhenGenerateContentFails();
  await testGenerateCaptionDeletesFileEvenWhenUploadQuotaExceeded();

  console.log("gemini-adapter tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
