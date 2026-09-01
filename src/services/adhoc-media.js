/*
  Preparo da midia anexada no Disparador Pontual (upload manual), antes de ela
  seguir para a Evolution API.

  Existe separado de queues/dispatch-media.js de proposito: aquele modulo e do
  caminho de campanha de video do Drive, acoplado a campaign_id/video_id e aos
  eventos de log "dispatch.*". Aqui a origem e um upload avulso, sem campanha nem
  video do catalogo, e o alvo de tamanho e outro (ver adhocVideoTargetBytes).
  A compressao em si nao e reimplementada: reusa services/video-compression.js.

  Restricao que este modulo respeita: o anexo NUNCA e persistido. Ele chega em
  base64 (multer memoryStorage), vira Buffer aqui e volta a base64 - nada e
  gravado em disco alem do scratch que o proprio ffmpeg cria em os.tmpdir() e
  apaga num `finally`.

  Por que comprimir: o WhatsApp entrega video inline ate ~16 MB; acima disso ele
  recompacta por conta propria ou simplesmente nao exibe. Reduzir para o alvo
  antes de enviar e o que faz o video chegar com qualidade previsivel, em vez de
  o disparo falhar (HTTP 413) ou o video sumir no grupo.
*/
const { evolutionConfig } = require("../config/evolution");
const { isDispatchVideoCompressionEnabled } = require("../queues/dispatch-media");
const {
  base64Length,
  compressVideoToFitBase64Budget,
  isMp4Container,
  normalizeVideoContainerToMp4,
} = require("./video-compression");

// Orcamento em bytes de base64 equivalente ao alvo de bytes crus. O
// video-compression raciocina em base64 porque e assim que a midia viaja no
// corpo JSON da Evolution.
function resolveAdHocVideoBase64Budget(config = evolutionConfig) {
  const targetBytes = Number(config.adhocVideoTargetBytes);

  if (!Number.isFinite(targetBytes) || targetBytes <= 0) {
    return null;
  }

  return base64Length(targetBytes);
}

function isVideoContent(content) {
  return Boolean(content) && content.type === "video" && typeof content.base64 === "string" && content.base64.length > 0;
}

// Converte o content do controller ({base64, mimeType, fileName, type}) para o
// formato que video-compression espera ({bytes, name, mime_type}) e de volta.
function toCompressionInput(content) {
  return {
    bytes: Buffer.from(content.base64, "base64"),
    name: content.fileName,
    mime_type: content.mimeType,
  };
}

function toDispatchContent(prepared, originalContent) {
  return {
    ...originalContent,
    base64: prepared.bytes.toString("base64"),
    mimeType: prepared.mime_type || originalContent.mimeType,
    fileName: prepared.name || originalContent.fileName,
    type: "video",
  };
}

/*
  Recebe o content ja normalizado pelo mensagens.service e devolve um content
  pronto para envio: container mp4 e tamanho dentro do alvo.

  Imagem, link e ausencia de midia passam intactos - o pipeline aqui e de video.
  As dependencias (compressVideo/normalizeContainer/config) sao injetaveis para
  os testes nao precisarem rodar ffmpeg.
*/
async function prepareAdHocMediaContent(content, options = {}) {
  const {
    compressVideo = compressVideoToFitBase64Budget,
    config = evolutionConfig,
    logger = console,
    normalizeContainer = normalizeVideoContainerToMp4,
  } = options;

  if (!isVideoContent(content)) {
    return content;
  }

  const maxBase64Bytes = resolveAdHocVideoBase64Budget(config);
  let video = toCompressionInput(content);
  const originalBytes = video.bytes.length;
  const needsContainerNormalization = !isMp4Container(video);
  const needsCompression = Boolean(maxBase64Bytes) && base64Length(originalBytes) > maxBase64Bytes;

  if (!needsContainerNormalization && !needsCompression) {
    return content;
  }

  if (!isDispatchVideoCompressionEnabled()) {
    logger.warn &&
      logger.warn(
        JSON.stringify({
          event: "adhoc_media.compression.skipped",
          file_name: content.fileName,
          source_mime_type: content.mimeType,
          bytes: originalBytes,
          reason: "EVOLUTION_MEDIA_COMPRESSION_ENABLED=false",
        })
      );

    return content;
  }

  logger.info &&
    logger.info(
      JSON.stringify({
        event: "adhoc_media.compression.started",
        file_name: content.fileName,
        source_mime_type: content.mimeType,
        bytes: originalBytes,
        base64_bytes: base64Length(originalBytes),
        max_base64_bytes: maxBase64Bytes,
        container_normalization: needsContainerNormalization,
      })
    );

  if (needsContainerNormalization) {
    // O fallback do normalizeContainer (quando o remux falha) ja recomprime
    // mirando este mesmo orcamento, entao o video pode sair daqui pronto.
    const normalized = await normalizeContainer(video, {
      logger,
      maxBase64Bytes: maxBase64Bytes || base64Length(originalBytes),
    });

    if (normalized !== video) {
      // Libera os bytes originais assim que a versao mp4 existe, para nao manter
      // as duas copias na memoria durante o resto do preparo.
      video.bytes = undefined;
      video = normalized;
    }
  }

  if (maxBase64Bytes && base64Length(video.bytes.length) > maxBase64Bytes) {
    const compressed = await compressVideo(video, { logger, maxBase64Bytes });

    if (compressed !== video) {
      video.bytes = undefined;
      video = compressed;
    }
  }

  logger.info &&
    logger.info(
      JSON.stringify({
        event: "adhoc_media.compression.completed",
        file_name: video.name,
        mime_type: video.mime_type,
        original_bytes: originalBytes,
        bytes: video.bytes.length,
        base64_bytes: base64Length(video.bytes.length),
      })
    );

  return toDispatchContent(video, content);
}

module.exports = {
  prepareAdHocMediaContent,
  resolveAdHocVideoBase64Budget,
};
