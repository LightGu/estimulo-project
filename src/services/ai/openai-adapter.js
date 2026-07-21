const process = require("node:process");

const AIProviderAdapter = require("./ai-provider-adapter");
const { DEFAULT_TRANSCRIPTION_PROMPT } = require("./constants");
const { assertFetch, readResponseJson } = require("./http-utils");

const DEFAULT_OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

function extractOpenAITranscriptionText(response) {
  const text = String(response?.text || "").trim();

  if (!text) {
    throw new Error("OpenAI nao retornou legenda em texto");
  }

  return text;
}

function assertMultipartSupport() {
  if (typeof FormData !== "function" || typeof Blob !== "function") {
    throw new Error("FormData e Blob sao obrigatorios para gerar legenda com OpenAI");
  }
}

function createFileBlob(downloadedVideo) {
  if (!downloadedVideo?.bytes) {
    throw new Error("Arquivo de video e obrigatorio para gerar legenda com OpenAI");
  }

  return new Blob([downloadedVideo.bytes], {
    type: downloadedVideo.mime_type || "application/octet-stream",
  });
}

class OpenAIAdapter extends AIProviderAdapter {
  async generateCaption(downloadedVideo, callOptions = {}) {
    const apiKey = callOptions.apiKey || this.options.apiKey || process.env.OPENAI_API_KEY;
    const fetchImplementation = callOptions.fetch || this.options.fetch || globalThis.fetch;
    const model =
      callOptions.model ||
      this.options.model ||
      process.env.OPENAI_TRANSCRIPTION_MODEL ||
      DEFAULT_OPENAI_TRANSCRIPTION_MODEL;
    const baseUrl = String(callOptions.baseUrl || this.options.baseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com")
      .replace(/\/$/, "");
    const prompt =
      callOptions.prompt || this.options.prompt || process.env.VIDEO_TRANSCRIPTION_PROMPT || DEFAULT_TRANSCRIPTION_PROMPT;
    const language = callOptions.language || this.options.language || process.env.OPENAI_TRANSCRIPTION_LANGUAGE;
    const fileName = downloadedVideo.name || `${downloadedVideo.drive_file_id || "video"}.mp4`;

    assertFetch(fetchImplementation, "OpenAI");
    assertMultipartSupport();

    if (!apiKey) {
      throw new Error("OPENAI_API_KEY e obrigatorio para gerar legenda");
    }

    const body = new FormData();
    body.append("file", createFileBlob(downloadedVideo), fileName);
    body.append("model", model);
    body.append("response_format", "json");

    if (prompt) {
      body.append("prompt", prompt);
    }

    if (language) {
      body.append("language", language);
    }

    const response = await fetchImplementation(`${baseUrl}/v1/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body,
    });

    return extractOpenAITranscriptionText(await readResponseJson(response, "Falha ao gerar legenda com OpenAI"));
  }
}

module.exports = {
  DEFAULT_OPENAI_TRANSCRIPTION_MODEL,
  OpenAIAdapter,
  extractOpenAITranscriptionText,
};
