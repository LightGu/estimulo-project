const process = require("node:process");

require("dotenv").config({ quiet: true });

const videoCatalogRepository = require("../repositories/video-catalog.repository");
const { downloadFromDrive } = require("./google-drive-video-download");

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_TRANSCRIPTION_PROMPT =
  "Transcreva fielmente todo o audio falado deste video em portugues brasileiro. Retorne apenas a transcricao em texto corrido. Preserve nomes proprios, termos tecnicos e numeros. Nao resuma, nao interprete, nao adicione comentarios, nao use markdown e nao inclua timestamps.";

function hasTranscript(videoCatalogRecord) {
  return Boolean(videoCatalogRecord && typeof videoCatalogRecord.transcript === "string" && videoCatalogRecord.transcript.trim());
}

function normalizeForce(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return ["true", "1", "sim", "yes", "force"].includes(value.trim().toLowerCase());
  }

  return false;
}

function assertFetch(fetchImplementation) {
  if (typeof fetchImplementation !== "function") {
    throw new Error("fetch e obrigatorio para transcrever video com Gemini");
  }
}

async function readResponseJson(response, context) {
  const text = await response.text();
  let parsed = {};

  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      parsed = {};
    }
  }

  if (!response.ok) {
    const apiMessage = parsed?.error?.message || text;
    throw new Error(`${context}: ${apiMessage || response.statusText}`);
  }

  return parsed;
}

function extractGeminiText(response) {
  const text = (response?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part?.text)
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("Gemini nao retornou transcricao em texto");
  }

  return text;
}

function resolveGeminiModelPath(model) {
  const normalizedModel = String(model || "").trim();

  if (!normalizedModel) {
    throw new Error("Modelo Gemini e obrigatorio para transcrever video");
  }

  return normalizedModel.startsWith("models/")
    ? normalizedModel
    : `models/${encodeURIComponent(normalizedModel)}`;
}

async function uploadGeminiFile(downloadedVideo, options = {}) {
  const fetchImplementation = options.fetch || globalThis.fetch;
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
  const baseUrl = options.baseUrl || "https://generativelanguage.googleapis.com";

  assertFetch(fetchImplementation);

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY ou GOOGLE_AI_API_KEY e obrigatorio para transcrever video");
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

function createGeminiVideoTranscriber(options = {}) {
  return {
    async transcribe(downloadedVideo) {
      const apiKey = options.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
      const fetchImplementation = options.fetch || globalThis.fetch;
      const model = options.model || process.env.GEMINI_TRANSCRIPTION_MODEL || DEFAULT_GEMINI_MODEL;
      const baseUrl = options.baseUrl || "https://generativelanguage.googleapis.com";
      const prompt = options.prompt || process.env.VIDEO_TRANSCRIPTION_PROMPT || DEFAULT_TRANSCRIPTION_PROMPT;

      assertFetch(fetchImplementation);

      if (!apiKey) {
        throw new Error("GEMINI_API_KEY ou GOOGLE_AI_API_KEY e obrigatorio para transcrever video");
      }

      const uploadedFile = await uploadGeminiFile(downloadedVideo, { ...options, apiKey, fetch: fetchImplementation, baseUrl });
      const activeFile = await waitForGeminiFile(uploadedFile, { ...options, apiKey, fetch: fetchImplementation });

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

      return extractGeminiText(await readResponseJson(response, "Falha ao gerar transcricao com Gemini"));
    },
  };
}

function createVideoTranscriptionService(dependencies = {}) {
  const repository = dependencies.repository || videoCatalogRepository;
  const downloadVideo = dependencies.downloadFromDrive || downloadFromDrive;
  const transcriber = dependencies.transcriber || createGeminiVideoTranscriber(dependencies.gemini || {});

  async function transcribeRecord(videoCatalogRecord, options = {}) {
    if (!videoCatalogRecord) {
      throw new Error("Registro video_catalog nao encontrado");
    }

    if (!videoCatalogRecord.drive_file_id) {
      throw new Error("drive_file_id e obrigatorio para transcrever video");
    }

    const force = normalizeForce(options.force);

    if (hasTranscript(videoCatalogRecord) && !force) {
      return {
        skipped: true,
        transcript: videoCatalogRecord.transcript,
        video: videoCatalogRecord,
      };
    }

    const downloadedVideo = await downloadVideo({
      drive: dependencies.drive,
      googleDriveOptions: dependencies.googleDriveOptions,
      videoCatalogRecord,
      videoCatalogRepository: repository,
    });
    const transcript = String(await transcriber.transcribe(downloadedVideo)).trim();

    if (!transcript) {
      throw new Error("Transcricao gerada esta vazia");
    }

    const video = await repository.update(videoCatalogRecord.id, { transcript });

    return {
      skipped: false,
      transcript,
      video,
    };
  }

  async function transcribeById(videoId, options = {}) {
    if (!videoId) {
      throw new Error("Video id is required");
    }

    const videoCatalogRecord = await repository.findById(videoId);

    return transcribeRecord(videoCatalogRecord, options);
  }

  async function transcribeByDriveFileId(driveFileId, options = {}) {
    const normalizedDriveFileId = String(driveFileId || "").trim();

    if (!normalizedDriveFileId) {
      throw new Error("Drive file id is required");
    }

    const videoCatalogRecord = await repository.findByDriveFileId(normalizedDriveFileId);

    return transcribeRecord(videoCatalogRecord, options);
  }

  return {
    transcribeByDriveFileId,
    transcribeById,
    transcribeVideo: transcribeRecord,
    transcribeRecord,
  };
}

module.exports = createVideoTranscriptionService();
module.exports.createGeminiVideoTranscriber = createGeminiVideoTranscriber;
module.exports.createVideoTranscriptionService = createVideoTranscriptionService;
module.exports.extractGeminiText = extractGeminiText;
module.exports.hasTranscript = hasTranscript;
module.exports.normalizeForce = normalizeForce;
module.exports.resolveGeminiModelPath = resolveGeminiModelPath;
