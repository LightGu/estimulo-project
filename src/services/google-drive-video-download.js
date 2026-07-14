const path = require("node:path");

const { createGoogleDriveClient } = require("./google-drive");

const VIDEO_MIME_TYPES_BY_EXTENSION = {
  ".3g2": "video/3gpp2",
  ".3gp": "video/3gpp",
  ".avi": "video/x-msvideo",
  ".m4v": "video/x-m4v",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".webm": "video/webm",
  ".wmv": "video/x-ms-wmv",
};

function assertDriveClient(drive) {
  if (!drive || !drive.files || typeof drive.files.get !== "function") {
    throw new Error("drive.files.get e obrigatorio para baixar video do Google Drive");
  }
}

function normalizeHeader(headers = {}, headerName) {
  const normalizedName = headerName.toLowerCase();
  const header = Object.entries(headers).find(([key]) => key.toLowerCase() === normalizedName);

  return header && header[1];
}

function normalizeMimeType(value) {
  if (!value) {
    return undefined;
  }

  return String(value).split(";")[0].trim() || undefined;
}

function isVideoMimeType(value) {
  return Boolean(value && value.toLowerCase().startsWith("video/"));
}

function selectVideoMimeType(...candidates) {
  const normalizedCandidates = candidates.map(normalizeMimeType).filter(Boolean);

  return normalizedCandidates.find(isVideoMimeType) || normalizedCandidates[0] || "application/octet-stream";
}

function normalizeFileName(value, fallbackDriveFileId) {
  const name = value && String(value).trim();

  if (name) {
    return name;
  }

  return fallbackDriveFileId ? `${fallbackDriveFileId}.mp4` : "video.mp4";
}

function inferVideoMimeTypeFromName(fileName) {
  const extension = path.extname(fileName || "").toLowerCase();

  return VIDEO_MIME_TYPES_BY_EXTENSION[extension];
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }

  if (typeof data === "string") {
    return Buffer.from(data);
  }

  throw new Error("Resposta da Google Drive API nao contem bytes de video em formato suportado");
}

function assertValidDownloadedVideo(downloadedVideo) {
  if (!downloadedVideo || !Buffer.isBuffer(downloadedVideo.bytes)) {
    throw new Error("Download do Google Drive nao retornou bytes de video validos");
  }

  if (downloadedVideo.bytes.length === 0) {
    throw new Error("Download do Google Drive retornou video vazio");
  }

  if (!isVideoMimeType(downloadedVideo.mime_type)) {
    throw new Error(`Tipo MIME invalido para envio de video: ${downloadedVideo.mime_type || "indefinido"}`);
  }
}

async function resolveVideoCatalogRecord(params = {}) {
  if (params.videoCatalogRecord) {
    return params.videoCatalogRecord;
  }

  if (params.videoCatalog) {
    return params.videoCatalog;
  }

  if (params.driveFileId || params.drive_file_id) {
    return {
      id: params.videoId || params.video_id,
      drive_file_id: params.driveFileId || params.drive_file_id,
      name: params.name,
      mime_type: params.mimeType || params.mime_type,
    };
  }

  const repository = params.videoCatalogRepository;
  const videoId = params.videoId || params.video_id;

  if (!repository) {
    throw new Error("videoCatalogRepository e obrigatorio quando videoCatalogRecord nao e informado");
  }

  if (!videoId) {
    throw new Error("video_id e obrigatorio para buscar video_catalog");
  }

  if (typeof repository.findById === "function") {
    return repository.findById(videoId);
  }

  if (typeof repository.getById === "function") {
    return repository.getById(videoId);
  }

  throw new Error("videoCatalogRepository deve implementar findById(videoId) ou getById(videoId)");
}

async function downloadFromDrive(params = {}) {
  const drive = params.drive || createGoogleDriveClient(params.googleDriveOptions || {});
  const videoCatalogRecord = await resolveVideoCatalogRecord(params);

  assertDriveClient(drive);

  if (!videoCatalogRecord) {
    throw new Error("Registro video_catalog nao encontrado");
  }

  const driveFileId = videoCatalogRecord.drive_file_id || videoCatalogRecord.driveFileId;

  if (!driveFileId) {
    throw new Error("drive_file_id e obrigatorio para baixar video do Google Drive");
  }

  const response = await drive.files.get(
    {
      fileId: driveFileId,
      alt: "media",
      supportsAllDrives: true,
    },
    {
      responseType: "arraybuffer",
    }
  );
  const bytes = toBuffer(response.data);
  const responseMimeType = normalizeMimeType(normalizeHeader(response.headers, "content-type"));
  const name = normalizeFileName(
    videoCatalogRecord.name || videoCatalogRecord.file_name || videoCatalogRecord.filename,
    driveFileId
  );
  const inferredMimeType = inferVideoMimeTypeFromName(name);
  const mimeType = selectVideoMimeType(
    videoCatalogRecord.mime_type || videoCatalogRecord.mimeType,
    responseMimeType,
    inferredMimeType
  );
  const downloadedVideo = {
    video_id: videoCatalogRecord.id,
    drive_file_id: driveFileId,
    bytes,
    name,
    mime_type: mimeType,
    file_extension: videoCatalogRecord.file_extension || path.extname(name).replace(/^\./, "") || undefined,
    metadata: {
      name,
      mime_type: mimeType,
      size_bytes: bytes.length,
    },
  };

  assertValidDownloadedVideo(downloadedVideo);

  return downloadedVideo;
}

const downloadGoogleDriveVideoForDispatch = downloadFromDrive;

module.exports = {
  assertValidDownloadedVideo,
  downloadFromDrive,
  downloadGoogleDriveVideoForDispatch,
  resolveVideoCatalogRecord,
};
