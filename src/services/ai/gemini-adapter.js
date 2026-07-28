const process = require("node:process");

const AIProviderAdapter = require("./ai-provider-adapter");
const {
  DEFAULT_CAPTION_GENERATION_PROMPT,
  DEFAULT_CAPTION_REVIEW_PROMPT,
  DEFAULT_TRANSCRIPTION_PROMPT,
} = require("./constants");
const { RateLimitError, assertFetch, readResponseJson } = require("./http-utils");

const DEFAULT_GEMINI_MODEL = "gemini-flash-latest";

function resolveModelCandidates(callOptions, instanceOptions) {
  const explicit = callOptions.models || instanceOptions.models;

  if (Array.isArray(explicit) && explicit.length) {
    return explicit.filter(Boolean);
  }

  const single =
    callOptions.model ||
    instanceOptions.model ||
    process.env.GEMINI_TRANSCRIPTION_MODEL ||
    DEFAULT_GEMINI_MODEL;
  const fallbacks = String(process.env.GEMINI_TRANSCRIPTION_MODEL_FALLBACKS || "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);

  return [single, ...fallbacks].filter((model, index, all) => all.indexOf(model) === index);
}

function resolveTextModelCandidates(callOptions, instanceOptions) {
  const explicit = callOptions.models || instanceOptions.models;

  if (Array.isArray(explicit) && explicit.length) {
    return explicit.filter(Boolean);
  }

  const single = callOptions.model || instanceOptions.model || process.env.GEMINI_TEXT_MODEL || DEFAULT_GEMINI_MODEL;
  const fallbacks = String(process.env.GEMINI_TEXT_MODEL_FALLBACKS || "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);

  return [single, ...fallbacks].filter((model, index, all) => all.indexOf(model) === index);
}

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

async function listGeminiFiles(options = {}) {
  const fetchImplementation = options.fetch || globalThis.fetch;
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
  const baseUrl = options.baseUrl || "https://generativelanguage.googleapis.com";
  const pageSize = options.pageSize || 100;

  assertFetch(fetchImplementation, "Gemini");

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY ou GOOGLE_AI_API_KEY e obrigatorio para listar arquivos");
  }

  const files = [];
  let pageToken;

  do {
    const url = new URL(`${baseUrl}/v1beta/files`);
    url.searchParams.set("key", apiKey);
    url.searchParams.set("pageSize", String(pageSize));

    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const response = await fetchImplementation(url.toString());
    const payload = await readResponseJson(response, "Falha ao listar arquivos no Gemini");

    files.push(...(payload.files || []));
    pageToken = payload.nextPageToken;
  } while (pageToken);

  return files;
}

async function deleteGeminiFile(file, options = {}) {
  const fetchImplementation = options.fetch || globalThis.fetch;
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
  const baseUrl = options.baseUrl || "https://generativelanguage.googleapis.com";

  if (!file || !file.name) {
    return;
  }

  try {
    await fetchImplementation(`${baseUrl}/v1beta/${file.name}?key=${encodeURIComponent(apiKey)}`, {
      method: "DELETE",
    });
  } catch (error) {
    if (options.throwOnError) {
      throw error;
    }

    // Best-effort: o arquivo expira sozinho em 48h na Files API do Gemini,
    // entao uma falha aqui nao deve interromper o fluxo de geracao de legenda/transcricao.
  }
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
  async generateText(prompt, callOptions = {}) {
    const apiKey = callOptions.apiKey || this.options.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
    const fetchImplementation = callOptions.fetch || this.options.fetch || globalThis.fetch;
    const baseUrl = callOptions.baseUrl || this.options.baseUrl || "https://generativelanguage.googleapis.com";
    const modelCandidates = resolveTextModelCandidates(callOptions, this.options);

    assertFetch(fetchImplementation, "Gemini");

    if (!apiKey) {
      throw new Error("GEMINI_API_KEY ou GOOGLE_AI_API_KEY e obrigatorio para gerar legenda");
    }

    let lastRateLimitError = null;

    // Cota do free tier (ex.: 20 req/dia) esgota rapido em um unico modelo. Assim
    // como na transcricao de video, tentamos a cascata de fallback antes de
    // desistir, para nao falhar o dispatch por causa de um modelo especifico.
    for (const model of modelCandidates) {
      try {
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
                  parts: [{ text: prompt }],
                },
              ],
            }),
          }
        );

        return extractGeminiText(await readResponseJson(response, `Falha ao gerar texto com Gemini (modelo ${model})`));
      } catch (error) {
        if (!(error instanceof RateLimitError)) {
          throw error;
        }

        lastRateLimitError = error;
      }
    }

    throw lastRateLimitError || new Error("Nenhum modelo Gemini disponivel para gerar texto");
  }

  async generateCaptionFromTranscript(transcript, callOptions = {}) {
    const prompt = [
      callOptions.prompt || this.options.captionGenerationPrompt || DEFAULT_CAPTION_GENERATION_PROMPT,
      "",
      "Transcricao:",
      String(transcript || "").trim(),
    ].join("\n");

    return this.generateText(prompt, callOptions);
  }

  async reviewCaptionConsistency({ caption, transcript }, callOptions = {}) {
    const prompt = [
      callOptions.prompt || this.options.captionReviewPrompt || DEFAULT_CAPTION_REVIEW_PROMPT,
      "",
      "Legenda:",
      String(caption || "").trim(),
      "",
      "Transcricao:",
      String(transcript || "").trim(),
    ].join("\n");

    return this.generateText(prompt, callOptions);
  }

  // Faz upload do video para a Files API do Gemini, executa generateContent com o
  // prompt informado e retorna { file, text }. O arquivo enviado e sempre
  // deletado da Files API ao final (sucesso ou erro), liberando a cota de
  // armazenamento em vez de esperar a expiracao automatica em 48h.
  async generateFromVideo(downloadedVideo, prompt, callOptions = {}) {
    const apiKey = callOptions.apiKey || this.options.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
    const fetchImplementation = callOptions.fetch || this.options.fetch || globalThis.fetch;
    const baseUrl = callOptions.baseUrl || this.options.baseUrl || "https://generativelanguage.googleapis.com";
    const modelCandidates = resolveModelCandidates(callOptions, this.options);

    assertFetch(fetchImplementation, "Gemini");

    if (!apiKey) {
      throw new Error("GEMINI_API_KEY ou GOOGLE_AI_API_KEY e obrigatorio para gerar legenda");
    }

    const requestOptions = { ...this.options, ...callOptions, apiKey, fetch: fetchImplementation, baseUrl };
    const uploadedFile = await uploadGeminiFile(downloadedVideo, requestOptions);
    const activeFile = await waitForGeminiFile(uploadedFile, requestOptions);

    try {
      let lastRateLimitError = null;

      for (const model of modelCandidates) {
        try {
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

          const text = extractGeminiText(
            await readResponseJson(response, `Falha ao gerar legenda com Gemini (modelo ${model})`)
          );

          return { file: activeFile, text };
        } catch (error) {
          if (!(error instanceof RateLimitError)) {
            throw error;
          }

          lastRateLimitError = error;
        }
      }

      throw lastRateLimitError || new Error("Nenhum modelo Gemini disponivel para gerar legenda");
    } finally {
      await deleteGeminiFile(activeFile, requestOptions);
    }
  }

  async generateCaption(downloadedVideo, callOptions = {}) {
    const prompt =
      callOptions.prompt || this.options.prompt || process.env.VIDEO_TRANSCRIPTION_PROMPT || DEFAULT_TRANSCRIPTION_PROMPT;
    const { text } = await this.generateFromVideo(downloadedVideo, prompt, callOptions);

    return text;
  }
}

module.exports = {
  DEFAULT_GEMINI_MODEL,
  GeminiAdapter,
  deleteGeminiFile,
  extractGeminiText,
  listGeminiFiles,
  resolveGeminiModelPath,
  uploadGeminiFile,
  waitForGeminiFile,
};
