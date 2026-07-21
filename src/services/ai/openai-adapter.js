const process = require("node:process");

const AIProviderAdapter = require("./ai-provider-adapter");
const {
  DEFAULT_CAPTION_GENERATION_PROMPT,
  DEFAULT_CAPTION_REVIEW_PROMPT,
  DEFAULT_TRANSCRIPTION_PROMPT,
} = require("./constants");
const { assertFetch, readResponseJson } = require("./http-utils");

const DEFAULT_OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const DEFAULT_OPENAI_TEXT_MODEL = "gpt-4o-mini";

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
  async generateText(prompt, callOptions = {}) {
    const apiKey = callOptions.apiKey || this.options.apiKey || process.env.OPENAI_API_KEY;
    const fetchImplementation = callOptions.fetch || this.options.fetch || globalThis.fetch;
    const model = callOptions.textModel || this.options.textModel || process.env.OPENAI_TEXT_MODEL || DEFAULT_OPENAI_TEXT_MODEL;
    const baseUrl = String(callOptions.baseUrl || this.options.baseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com")
      .replace(/\/$/, "");

    assertFetch(fetchImplementation, "OpenAI");

    if (!apiKey) {
      throw new Error("OPENAI_API_KEY e obrigatorio para gerar legenda");
    }

    const response = await fetchImplementation(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
      }),
    });
    const payload = await readResponseJson(response, "Falha ao gerar texto com OpenAI");
    const text = String(payload?.choices?.[0]?.message?.content || "").trim();

    if (!text) {
      throw new Error("OpenAI nao retornou texto");
    }

    return text;
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
  DEFAULT_OPENAI_TEXT_MODEL,
  DEFAULT_OPENAI_TRANSCRIPTION_MODEL,
  OpenAIAdapter,
  extractOpenAITranscriptionText,
};
