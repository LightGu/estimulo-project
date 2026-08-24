/*
  Preparo da midia de video para o envio pela Evolution API.
  Extraido de queues/dispatch.js, que passava de 1400 linhas misturando
  enfileiramento, legenda, midia, notificacao e o processor.

  Responsabilidade unica: pegar o video baixado do Drive e deixa-lo num formato
  e tamanho que a Evolution aceite - validar, remuxar container, comprimir para
  caber no teto de payload e montar o payload final. Nao conhece fila, log,
  campanha nem grupo.
*/
const { evolutionConfig } = require("../config/evolution");
const {
  base64Length,
  compressVideoToFitBase64Budget,
  isMp4Container,
  normalizeVideoContainerToMp4,
} = require("../services/video-compression");

function assertDownloadedVideoForDispatch(downloadedVideo) {
  if (!downloadedVideo || !Buffer.isBuffer(downloadedVideo.bytes)) {
    throw new Error("Download do Google Drive nao retornou bytes de video validos");
  }

  if (downloadedVideo.bytes.length === 0) {
    throw new Error("Download do Google Drive retornou video vazio");
  }

  if (!downloadedVideo.mime_type || !downloadedVideo.mime_type.toLowerCase().startsWith("video/")) {
    throw new Error(`Tipo MIME invalido para envio de video: ${downloadedVideo.mime_type || "indefinido"}`);
  }
}

function buildDispatchDeliveryPayload(jobData, downloadedVideo) {
  if (downloadedVideo) {
    assertDownloadedVideoForDispatch(downloadedVideo);

    return {
      groupId: jobData.group_id,
      message: jobData.legenda || "",
      content: {
        base64: downloadedVideo.bytes.toString("base64"),
        fileName: downloadedVideo.name,
        mimeType: downloadedVideo.mime_type,
        type: "video",
      },
    };
  }

  return {
    groupId: jobData.group_id,
    message: jobData.legenda || "",
    content: {
      url: jobData.link_video,
      fileName: "campaign-video.mp4",
      mimeType: "video/mp4",
      type: "video",
    },
  };
}

const DISPATCH_PAYLOAD_ENVELOPE_RESERVE_BYTES = 64 * 1024;

function isDispatchVideoCompressionEnabled() {
  return String(process.env.EVOLUTION_MEDIA_COMPRESSION_ENABLED || "true").toLowerCase() !== "false";
}

function resolveDispatchMediaBase64Budget(config = evolutionConfig) {
  const limitBytes = Number(config.maxMediaPayloadBytes);

  if (!Number.isFinite(limitBytes) || limitBytes <= 0) {
    return null;
  }

  return limitBytes - DISPATCH_PAYLOAD_ENVELOPE_RESERVE_BYTES;
}

// O WhatsApp so exibe video de container mp4 de forma confiavel; .mov, .mkv,
// .avi etc sao aceitos pela Evolution API (HTTP 200) mas o destinatario nao
// recebe nada visivel, sem erro do nosso lado — descoberto apos um disparo em
// campanha onde grupos que receberiam .mov simplesmente nao viram o video,
// enquanto o mesmo arquivo enviado individualmente funcionou. Normaliza para
// mp4 (remux rapido, com fallback para recompressao) antes do envio.
async function normalizeDownloadedVideoContainer(downloadedVideo, options = {}) {
  const { config = evolutionConfig, jobData = {}, logger = console, normalizeContainer = normalizeVideoContainerToMp4 } =
    options;

  if (!downloadedVideo || !Buffer.isBuffer(downloadedVideo.bytes) || isMp4Container(downloadedVideo)) {
    return downloadedVideo;
  }

  if (!isDispatchVideoCompressionEnabled()) {
    logger.warn &&
      logger.warn(
        JSON.stringify({
          event: "dispatch.video_container_normalization.skipped",
          campaign_id: jobData.campaign_id,
          group_id: jobData.group_id,
          video_id: jobData.video_id,
          source_mime_type: downloadedVideo.mime_type,
          reason: "EVOLUTION_MEDIA_COMPRESSION_ENABLED=false",
        })
      );

    return downloadedVideo;
  }

  logger.info &&
    logger.info(
      JSON.stringify({
        event: "dispatch.video_container_normalization.started",
        campaign_id: jobData.campaign_id,
        group_id: jobData.group_id,
        progress_group_id: jobData.progress_group_id,
        video_id: jobData.video_id,
        source_mime_type: downloadedVideo.mime_type,
        bytes: downloadedVideo.bytes.length,
      })
    );

  const maxBase64Bytes = resolveDispatchMediaBase64Budget(config);
  const normalized = await normalizeContainer(downloadedVideo, {
    logger,
    maxBase64Bytes: maxBase64Bytes || base64Length(downloadedVideo.bytes.length),
  });

  if (normalized !== downloadedVideo) {
    // Libera os bytes originais assim que a versao mp4 existe, para nao manter
    // as duas versoes na memoria do worker durante o upload.
    downloadedVideo.bytes = undefined;
  }

  logger.info &&
    logger.info(
      JSON.stringify({
        event: "dispatch.video_container_normalization.completed",
        campaign_id: jobData.campaign_id,
        group_id: jobData.group_id,
        progress_group_id: jobData.progress_group_id,
        video_id: jobData.video_id,
        remuxed: Boolean(normalized.remuxed),
        compressed: Boolean(normalized.compressed),
        bytes: normalized.bytes.length,
      })
    );

  return normalized;
}

// A Evolution API recusa com HTTP 413 qualquer corpo acima do limite do
// body-parser dela (136 MB, fixo no bundle). Como a midia viaja em base64
// (+33% sobre o arquivo), video a partir de ~102 MB nunca era entregue: o job
// baixava o arquivo do Drive, montava o payload e tomava 413. Aqui o video e
// reduzido para caber antes do envio.
async function fitDownloadedVideoToEvolutionLimit(downloadedVideo, options = {}) {
  const { compressVideo = compressVideoToFitBase64Budget, config = evolutionConfig, jobData = {}, logger = console } =
    options;

  const containerNormalized = await normalizeDownloadedVideoContainer(downloadedVideo, options);

  if (!containerNormalized || !Buffer.isBuffer(containerNormalized.bytes)) {
    return containerNormalized;
  }

  const maxBase64Bytes = resolveDispatchMediaBase64Budget(config);

  if (!maxBase64Bytes || base64Length(containerNormalized.bytes.length) <= maxBase64Bytes) {
    return containerNormalized;
  }

  if (!isDispatchVideoCompressionEnabled()) {
    logger.warn &&
      logger.warn(
        JSON.stringify({
          event: "dispatch.video_compression.skipped",
          campaign_id: jobData.campaign_id,
          group_id: jobData.group_id,
          video_id: jobData.video_id,
          bytes: containerNormalized.bytes.length,
          max_base64_bytes: maxBase64Bytes,
          reason: "EVOLUTION_MEDIA_COMPRESSION_ENABLED=false",
        })
      );

    return containerNormalized;
  }

  logger.info &&
    logger.info(
      JSON.stringify({
        event: "dispatch.video_compression.started",
        campaign_id: jobData.campaign_id,
        group_id: jobData.group_id,
        progress_group_id: jobData.progress_group_id,
        video_id: jobData.video_id,
        bytes: containerNormalized.bytes.length,
        base64_bytes: base64Length(containerNormalized.bytes.length),
        max_base64_bytes: maxBase64Bytes,
      })
    );

  const compressed = await compressVideo(containerNormalized, { logger, maxBase64Bytes });

  if (compressed !== containerNormalized) {
    // Libera os bytes originais (~125 MB) assim que o video reduzido existe, para
    // nao manter as duas versoes na memoria do worker durante o upload.
    containerNormalized.bytes = undefined;
  }

  logger.info &&
    logger.info(
      JSON.stringify({
        event: "dispatch.video_compression.completed",
        campaign_id: jobData.campaign_id,
        group_id: jobData.group_id,
        progress_group_id: jobData.progress_group_id,
        video_id: jobData.video_id,
        bytes: compressed.bytes.length,
        base64_bytes: base64Length(compressed.bytes.length),
      })
    );

  return compressed;
}

function releaseTemporaryDispatchMedia(downloadedVideo, deliveryPayload) {
  if (downloadedVideo) {
    downloadedVideo.bytes = undefined;
  }

  if (deliveryPayload && deliveryPayload.content) {
    deliveryPayload.content.base64 = undefined;
  }
}

module.exports = {
  DISPATCH_PAYLOAD_ENVELOPE_RESERVE_BYTES,
  assertDownloadedVideoForDispatch,
  buildDispatchDeliveryPayload,
  fitDownloadedVideoToEvolutionLimit,
  isDispatchVideoCompressionEnabled,
  normalizeDownloadedVideoContainer,
  releaseTemporaryDispatchMedia,
  resolveDispatchMediaBase64Budget,
};
