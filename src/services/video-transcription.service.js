require("dotenv").config({ quiet: true });

const videoCatalogRepository = require("../repositories/video-catalog.repository");
const { createAIProviderAdapter } = require("./ai");
const {
  GeminiAdapter,
  extractGeminiText,
  resolveGeminiModelPath,
} = require("./ai/gemini-adapter");
const { downloadFromDrive } = require("./google-drive-video-download");

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

function createGeminiVideoTranscriber(options = {}) {
  return new GeminiAdapter(options);
}

async function generateCaption(adapter, downloadedVideo, options = {}) {
  if (adapter && typeof adapter.generateCaption === "function") {
    return adapter.generateCaption(downloadedVideo, options);
  }

  if (adapter && typeof adapter.transcribe === "function") {
    return adapter.transcribe(downloadedVideo, options);
  }

  throw new Error("AIProviderAdapter invalido: generateCaption e obrigatorio");
}

function createVideoTranscriptionService(dependencies = {}) {
  const repository = dependencies.repository || videoCatalogRepository;
  const downloadVideo = dependencies.downloadFromDrive || downloadFromDrive;
  const configuredAIOptions = {
    ...(dependencies.ai || {}),
    gemini: dependencies.gemini,
    openai: dependencies.openai,
  };

  function getAIProviderAdapter() {
    return (
      dependencies.aiProviderAdapter ||
      dependencies.transcriber ||
      createAIProviderAdapter(configuredAIOptions)
    );
  }

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
    const transcript = String(await generateCaption(getAIProviderAdapter(), downloadedVideo, options)).trim();

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
module.exports.generateCaption = generateCaption;
module.exports.hasTranscript = hasTranscript;
module.exports.normalizeForce = normalizeForce;
module.exports.resolveGeminiModelPath = resolveGeminiModelPath;
