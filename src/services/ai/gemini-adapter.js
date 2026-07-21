const process = require("node:process");

const AIProviderAdapter = require("./ai-provider-adapter");
const { DEFAULT_TRANSCRIPTION_PROMPT } = require("./constants");
const { assertFetch, readResponseJson } = require("./http-utils");

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

function extractGeminiText(response) {
  const text = (response?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part?.text)
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("Gemini nao retornou legenda em texto");
  }

  return text;
}

function resolveGeminiModelPath(model) {
  const normalizedModel = String(model || "").trim();

  if (!normalizedModel) {
    throw new Error("Modelo Gemini e obrigatorio para gerar legenda");
  }

  return normalizedModel.startsWith("models/")
    ? normalizedModel
    : `models/${encodeURIComponent(normalizedModel)}`;
}

async function uploadGeminiFile(downloadedVideo, options = {}) {
  const fetchImplementation = options.fetch || globalThis.fetch;
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
  const baseUrl = options.baseUrl || "https://generativelanguage.googleapis.com";

  assertFetch(fetchImplementation, "Gemini");

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY ou GOOGLE_AI_API_KEY e obrigatorio para gerar legenda");
  }

  const startResponse = await fetchImplementation(`${baseUrl}/upload/v1beta/files?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(downloadedVideo.bytes.length),
      "X-Goog-Upload-Header-Content-Type": downloadedVideo.mime_type,
      "X-Goog-Upload-Protocol": "resumable",
    },
    body: JSON.stringify({
      file: {
        display_name: downloadedVideo.name,
      },
    }),
  });

  if (!startResponse.ok) {
    await readResponseJson(startResponse, "Falha ao iniciar upload do video no Gemini");
  }

  const uploadUrl = startResponse.headers.get("x-goog-upload-url");

  if (!uploadUrl) {
    throw new Error("Gemini nao retornou URL de upload");
  }

  const uploadResponse = await fetchImplementation(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(downloadedVideo.bytes.length),
      "Content-Type": downloadedVideo.mime_type,
      "X-Goog-Upload-Command": "upload, finalize",
      "X-Goog-Upload-Offset": "0",
    },
    body: downloadedVideo.bytes,
  });

  const uploaded = await readResponseJson(uploadResponse, "Falha ao enviar video para Gemini");
  const file = uploaded.file;

  if (!file?.uri) {
    throw new Error("Gemini nao retornou URI do arquivo enviado");
  }

  return file;
}

async function waitForGeminiFile(file, options = {}) {
  const fetchImplementation = options.fetch || globalThis.fetch;
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
  const baseUrl = options.baseUrl || "https://generativelanguage.googleapis.com";
  const pollIntervalMs = options.pollIntervalMs || 5000;
  const maxAttempts = options.maxAttempts || 24;
  let currentFile = file;

  if (!currentFile.name || currentFile.state === "ACTIVE") {
    return currentFile;
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (currentFile.state === "FAILED") {
      throw new Error("Processamento do video no Gemini falhou");
    }

    if (currentFile.state === "ACTIVE") {
      return currentFile;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    const response = await fetchImplementation(
      `${baseUrl}/v1beta/${currentFile.name}?key=${encodeURIComponent(apiKey)}`
    );
    const payload = await readResponseJson(response, "Falha ao consultar processamento do video no Gemini");
    currentFile = payload;
  }

  throw new Error("Tempo limite ao aguardar processamento do video no Gemini");
}

class GeminiAdapter extends AIProviderAdapter {
  async generateCaption(downloadedVideo, callOptions = {}) {
    const apiKey = callOptions.apiKey || this.options.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
    const fetchImplementation = callOptions.fetch || this.options.fetch || globalThis.fetch;
    const model = callOptions.model || this.options.model || process.env.GEMINI_TRANSCRIPTION_MODEL || DEFAULT_GEMINI_MODEL;
    const baseUrl = callOptions.baseUrl || this.options.baseUrl || "https://generativelanguage.googleapis.com";
    const prompt =
      callOptions.prompt || this.options.prompt || process.env.VIDEO_TRANSCRIPTION_PROMPT || DEFAULT_TRANSCRIPTION_PROMPT;

    assertFetch(fetchImplementation, "Gemini");

    if (!apiKey) {
      throw new Error("GEMINI_API_KEY ou GOOGLE_AI_API_KEY e obrigatorio para gerar legenda");
    }

    const requestOptions = { ...this.options, ...callOptions, apiKey, fetch: fetchImplementation, baseUrl };
    const uploadedFile = await uploadGeminiFile(downloadedVideo, requestOptions);
    const activeFile = await waitForGeminiFile(uploadedFile, requestOptions);

    const response = await fetchImplementation(
      `${baseUrl}/v1beta/${resolveGeminiModelPath(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { file_data: { mime_type: downloadedVideo.mime_type, file_uri: activeFile.uri } },
                { text: prompt },
              ],
            },
          ],
        }),
      }
    );

    return extractGeminiText(await readResponseJson(response, "Falha ao gerar legenda com Gemini"));
  }
}

module.exports = {
  DEFAULT_GEMINI_MODEL,
  GeminiAdapter,
  extractGeminiText,
  resolveGeminiModelPath,
  uploadGeminiFile,
  waitForGeminiFile,
};
