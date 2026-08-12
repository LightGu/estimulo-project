const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { resolveFfmpegPath } = require("./video-audio-extraction");

// A Evolution API recebe midia como base64 dentro do JSON e recusa corpos acima
// do limite do body-parser dela (136 MB, fixo no bundle) com HTTP 413. base64
// infla o arquivo em 33%, entao videos a partir de ~102 MB nunca chegam a ser
// processados. Este modulo reduz o video para caber no orcamento de bytes antes
// do envio, em vez de deixar o dispatch falhar num limite que nao controlamos.
const DEFAULT_MAX_HEIGHT = 720;
const DEFAULT_AUDIO_BITRATE_KBPS = 96;
const DEFAULT_MIN_VIDEO_BITRATE_KBPS = 300;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_REMUX_TIMEOUT_MS = 5 * 60 * 1000;
// O x264 nao acerta o bitrate pedido no alvo exato (overhead de container, GOP,
// picos de cena). Miramos abaixo do orcamento para nao gastar uma recompressao
// inteira por causa de alguns MB de estouro.
const TARGET_FILL_RATIO = 0.9;
const OUTPUT_EXTENSION = ".mp4";
const OUTPUT_MIME_TYPE = "video/mp4";

// base64 codifica cada 3 bytes em 4 caracteres, com padding no ultimo bloco.
function base64Length(byteLength) {
  return Math.ceil(byteLength / 3) * 4;
}

// Inverso de base64Length: quantos bytes crus cabem num orcamento de base64.
function maxRawBytesForBase64Budget(base64BudgetBytes) {
  return Math.max(0, Math.floor(base64BudgetBytes / 4) * 3);
}

function fitsBase64Budget(byteLength, base64BudgetBytes) {
  return base64Length(byteLength) <= base64BudgetBytes;
}

function runFfmpeg(ffmpegPath, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      windowsHide: true,
    });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    // Um "error" sem listener num stream e excecao nao capturada, que mata o
    // processo inteiro. Os pipes do ffmpeg podem errar (EPIPE/ECONNRESET) quando o
    // processo e derrubado pelo timeout no meio de um video longo. O desfecho real
    // vem de "error"/"close" no proprio child, aqui so evitamos o evento solto.
    child.stderr.on("error", () => {});
    child.stdout && child.stdout.on("error", () => {});

    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        reject(
          new Error(
            `ffmpeg nao encontrado em "${ffmpegPath}". Instale as dependencias do projeto (npm install) ou defina FFMPEG_PATH.`
          )
        );

        return;
      }

      reject(error);
    });

    child.on("close", (code, signal) => {
      resolve({ code, signal, stderr });
    });
  });
}

function parseFfmpegDurationSeconds(stderr) {
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(String(stderr || ""));

  if (!match) {
    return null;
  }

  const [, hours, minutes, seconds, fraction] = match;
  const total =
    Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + (fraction ? Number(`0.${fraction}`) : 0);

  return total > 0 ? total : null;
}

// `ffmpeg -i arquivo` sem output sai com codigo 1, mas imprime o header com a
// duracao no stderr. Usar isso evita adicionar o ffprobe como dependencia nova.
async function probeDurationSeconds(ffmpegPath, inputPath, options = {}) {
  const { stderr } = await runFfmpeg(ffmpegPath, ["-hide_banner", "-i", inputPath], options);

  return parseFfmpegDurationSeconds(stderr);
}

function resolveVideoBitrateKbps(params = {}) {
  const { targetBytes, durationSeconds, audioBitrateKbps = DEFAULT_AUDIO_BITRATE_KBPS } = params;
  const totalKbps = (targetBytes * 8) / 1000 / durationSeconds;

  return Math.max(DEFAULT_MIN_VIDEO_BITRATE_KBPS, Math.floor(totalKbps - audioBitrateKbps));
}

function buildCompressionFfmpegArgs(inputPath, outputPath, options = {}) {
  const videoBitrateKbps = options.videoBitrateKbps;
  const audioBitrateKbps = options.audioBitrateKbps || DEFAULT_AUDIO_BITRATE_KBPS;
  const maxHeight = options.maxHeight || DEFAULT_MAX_HEIGHT;

  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    // min(maxHeight, ih) nunca faz upscale; -2 na largura mantem a proporcao com
    // dimensao par (exigencia do yuv420p). A virgula precisa vir escapada porque
    // o ffmpeg a usa como separador de filtros.
    "-vf",
    `scale=-2:min(${maxHeight}\\,ih)`,
    "-c:v",
    "libx264",
    "-preset",
    options.preset || "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-b:v",
    `${videoBitrateKbps}k`,
    // Teto de bitrate instantaneo: sem ele uma cena de muito movimento estoura o
    // tamanho medio planejado e o arquivo final passa do orcamento.
    "-maxrate",
    `${Math.floor(videoBitrateKbps * 1.25)}k`,
    "-bufsize",
    `${videoBitrateKbps * 2}k`,
    "-c:a",
    "aac",
    "-b:a",
    `${audioBitrateKbps}k`,
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    outputPath,
  ];
}

function resolveCompressedFileName(downloadedVideo) {
  const name = String((downloadedVideo && downloadedVideo.name) || "video").trim() || "video";
  const extension = path.extname(name);
  const baseName = extension ? name.slice(0, -extension.length) : name;

  return `${baseName || "video"}${OUTPUT_EXTENSION}`;
}

function resolveInputExtension(downloadedVideo) {
  const extension = path.extname(String((downloadedVideo && downloadedVideo.name) || "")).toLowerCase();

  return extension || OUTPUT_EXTENSION;
}

function isMp4Container(downloadedVideo) {
  return String((downloadedVideo && downloadedVideo.mime_type) || "").toLowerCase() === OUTPUT_MIME_TYPE;
}

function buildRemuxFfmpegArgs(inputPath, outputPath) {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    // -c copy troca so o container (mp4 em vez de mov/mkv/etc), sem recodificar
    // video/audio: e quase instantaneo e sem perda, mas so funciona quando os
    // streams de origem (tipicamente H.264/AAC em .mov de iPhone) sao aceitos
    // dentro de um container mp4. +faststart move o moov atom para o inicio do
    // arquivo, que o WhatsApp espera para tocar o video sem baixar tudo antes.
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    outputPath,
  ];
}

// O WhatsApp so exibe video de container mp4 (H.264/AAC) de forma confiavel;
// .mov, .mkv, .avi etc chegam pela Evolution API com HTTP 200 (aceite) mas o
// destinatario nao recebe nada visivel, sem qualquer erro no nosso lado. Este
// modulo tenta primeiro um remux (copia de stream, ~instantaneo) antes de cair
// para a recompressao completa, que e bem mais lenta.
async function remuxVideoToMp4(downloadedVideo, options = {}) {
  const logger = options.logger || console;
  const ffmpegPath = resolveFfmpegPath(options);
  const workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "estimulo-remux-"));
  const inputPath = path.join(workingDirectory, `input${resolveInputExtension(downloadedVideo)}`);
  const outputPath = path.join(workingDirectory, `output${OUTPUT_EXTENSION}`);

  try {
    await fs.writeFile(inputPath, downloadedVideo.bytes);

    const { code, signal, stderr } = await runFfmpeg(ffmpegPath, buildRemuxFfmpegArgs(inputPath, outputPath), {
      ...options,
      timeoutMs: options.timeoutMs || DEFAULT_REMUX_TIMEOUT_MS,
    });

    if (code !== 0) {
      const details = String(stderr || "").trim().split("\n").slice(-5).join(" | ");

      logger.warn &&
        logger.warn(
          JSON.stringify({
            event: "video_compression.remux_failed",
            video_id: downloadedVideo.video_id,
            source_mime_type: downloadedVideo.mime_type,
            code,
            signal,
            details,
          })
        );

      return null;
    }

    const remuxedBytes = await fs.readFile(outputPath);

    if (!remuxedBytes.length) {
      return null;
    }

    const name = resolveCompressedFileName(downloadedVideo);

    logger.info &&
      logger.info(
        JSON.stringify({
          event: "video_compression.remux_completed",
          video_id: downloadedVideo.video_id,
          source_mime_type: downloadedVideo.mime_type,
          original_bytes: downloadedVideo.bytes.length,
          remuxed_bytes: remuxedBytes.length,
        })
      );

    return {
      ...downloadedVideo,
      bytes: remuxedBytes,
      name,
      mime_type: OUTPUT_MIME_TYPE,
      file_extension: OUTPUT_EXTENSION.replace(/^\./, ""),
      remuxed: true,
      source_mime_type: downloadedVideo.mime_type,
      source_size_bytes: downloadedVideo.bytes.length,
      metadata: {
        ...(downloadedVideo.metadata || {}),
        name,
        mime_type: OUTPUT_MIME_TYPE,
        size_bytes: remuxedBytes.length,
        remuxed: true,
        source_mime_type: downloadedVideo.mime_type,
        source_size_bytes: downloadedVideo.bytes.length,
      },
    };
  } finally {
    await fs.rm(workingDirectory, { force: true, recursive: true }).catch(() => {});
  }
}

// Garante que o video sai deste modulo em container mp4, que e o unico que o
// WhatsApp exibe de forma confiavel em grupo. Tenta o remux rapido (sem perda)
// primeiro; se ele falhar (codec incompativel, ex. HEVC/ProRes em .mov), cai
// para a recompressao completa (que ja e usada para caber no limite de
// payload) — ela sempre produz mp4 valido, custando apenas mais tempo de CPU.
async function normalizeVideoContainerToMp4(downloadedVideo, options = {}) {
  if (!downloadedVideo || !Buffer.isBuffer(downloadedVideo.bytes) || downloadedVideo.bytes.length === 0) {
    throw new Error("Bytes do video sao obrigatorios para normalizar o container");
  }

  if (isMp4Container(downloadedVideo)) {
    return downloadedVideo;
  }

  const remuxed = await remuxVideoToMp4(downloadedVideo, options);

  if (remuxed) {
    return remuxed;
  }

  const maxBase64Bytes = Number(options.maxBase64Bytes);
  const fallbackBudget = Number.isFinite(maxBase64Bytes) && maxBase64Bytes > 0 ? maxBase64Bytes : base64Length(downloadedVideo.bytes.length);

  return compressVideoToFitBase64Budget(downloadedVideo, { ...options, maxBase64Bytes: fallbackBudget });
}

// Recebe o objeto de downloadFromDrive e devolve o mesmo formato com os bytes
// recomprimidos para caber em `maxBase64Bytes` apos a codificacao base64. Quando
// o video ja cabe, retorna o objeto original sem invocar o ffmpeg.
async function compressVideoToFitBase64Budget(downloadedVideo, options = {}) {
  if (!downloadedVideo || !Buffer.isBuffer(downloadedVideo.bytes) || downloadedVideo.bytes.length === 0) {
    throw new Error("Bytes do video sao obrigatorios para recomprimir");
  }

  const maxBase64Bytes = Number(options.maxBase64Bytes);

  if (!Number.isFinite(maxBase64Bytes) || maxBase64Bytes <= 0) {
    throw new Error("maxBase64Bytes deve ser um numero positivo para recomprimir o video");
  }

  if (fitsBase64Budget(downloadedVideo.bytes.length, maxBase64Bytes)) {
    return downloadedVideo;
  }

  const logger = options.logger || console;
  const ffmpegPath = resolveFfmpegPath(options);
  const maxRawBytes = maxRawBytesForBase64Budget(maxBase64Bytes);
  const maxAttempts = options.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  const audioBitrateKbps = options.audioBitrateKbps || DEFAULT_AUDIO_BITRATE_KBPS;
  const workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "estimulo-compress-"));
  const inputPath = path.join(workingDirectory, `input${resolveInputExtension(downloadedVideo)}`);
  const originalBytes = downloadedVideo.bytes.length;

  try {
    await fs.writeFile(inputPath, downloadedVideo.bytes);

    const durationSeconds = await probeDurationSeconds(ffmpegPath, inputPath, options);

    if (!durationSeconds) {
      throw new Error("Nao foi possivel determinar a duracao do video para calcular o bitrate de compressao");
    }

    let targetBytes = Math.floor(maxRawBytes * TARGET_FILL_RATIO);
    let lastBytes = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const outputPath = path.join(workingDirectory, `output-${attempt}${OUTPUT_EXTENSION}`);
      const videoBitrateKbps = resolveVideoBitrateKbps({ targetBytes, durationSeconds, audioBitrateKbps });
      const args = buildCompressionFfmpegArgs(inputPath, outputPath, {
        ...options,
        audioBitrateKbps,
        videoBitrateKbps,
      });

      logger.info &&
        logger.info(
          JSON.stringify({
            event: "video_compression.attempt",
            attempt,
            video_id: downloadedVideo.video_id,
            duration_seconds: Math.round(durationSeconds),
            original_bytes: originalBytes,
            target_bytes: targetBytes,
            video_bitrate_kbps: videoBitrateKbps,
          })
        );

      const { code, signal, stderr } = await runFfmpeg(ffmpegPath, args, options);

      if (code !== 0) {
        const details = String(stderr || "").trim().split("\n").slice(-5).join(" | ");

        throw new Error(
          `Falha ao recomprimir video com ffmpeg (code ${code}${signal ? `, signal ${signal}` : ""})${
            details ? `: ${details}` : ""
          }`
        );
      }

      const compressedBytes = await fs.readFile(outputPath);

      lastBytes = compressedBytes.length;

      if (!compressedBytes.length) {
        throw new Error("Recompressao gerou arquivo de video vazio");
      }

      if (fitsBase64Budget(compressedBytes.length, maxBase64Bytes)) {
        const name = resolveCompressedFileName(downloadedVideo);

        logger.info &&
          logger.info(
            JSON.stringify({
              event: "video_compression.completed",
              attempt,
              video_id: downloadedVideo.video_id,
              original_bytes: originalBytes,
              compressed_bytes: compressedBytes.length,
              base64_bytes: base64Length(compressedBytes.length),
              max_base64_bytes: maxBase64Bytes,
            })
          );

        return {
          ...downloadedVideo,
          bytes: compressedBytes,
          name,
          mime_type: OUTPUT_MIME_TYPE,
          file_extension: OUTPUT_EXTENSION.replace(/^\./, ""),
          compressed: true,
          source_mime_type: downloadedVideo.mime_type,
          source_size_bytes: originalBytes,
          metadata: {
            ...(downloadedVideo.metadata || {}),
            name,
            mime_type: OUTPUT_MIME_TYPE,
            size_bytes: compressedBytes.length,
            compressed: true,
            source_mime_type: downloadedVideo.mime_type,
            source_size_bytes: originalBytes,
          },
        };
      }

      // O arquivo saiu maior que o alvo: reaproveita a razao real/alvo para
      // corrigir o bitrate da proxima tentativa em vez de chutar um fator fixo.
      const overshootRatio = compressedBytes.length / targetBytes;

      targetBytes = Math.floor(targetBytes / Math.max(overshootRatio, 1.1));

      logger.warn &&
        logger.warn(
          JSON.stringify({
            event: "video_compression.over_budget",
            attempt,
            video_id: downloadedVideo.video_id,
            compressed_bytes: compressedBytes.length,
            max_raw_bytes: maxRawBytes,
            next_target_bytes: targetBytes,
          })
        );
    }

    throw new Error(
      `Nao foi possivel reduzir o video para o limite de ${maxBase64Bytes} bytes em base64 apos ${maxAttempts} tentativas (menor resultado: ${lastBytes} bytes)`
    );
  } finally {
    await fs.rm(workingDirectory, { force: true, recursive: true }).catch(() => {});
  }
}

module.exports = {
  DEFAULT_AUDIO_BITRATE_KBPS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_HEIGHT,
  DEFAULT_MIN_VIDEO_BITRATE_KBPS,
  DEFAULT_REMUX_TIMEOUT_MS,
  TARGET_FILL_RATIO,
  base64Length,
  buildCompressionFfmpegArgs,
  buildRemuxFfmpegArgs,
  compressVideoToFitBase64Budget,
  fitsBase64Budget,
  isMp4Container,
  maxRawBytesForBase64Budget,
  normalizeVideoContainerToMp4,
  parseFfmpegDurationSeconds,
  probeDurationSeconds,
  remuxVideoToMp4,
  resolveCompressedFileName,
  resolveVideoBitrateKbps,
};
