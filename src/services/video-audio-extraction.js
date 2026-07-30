const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const process = require("node:process");

// O agente de transcricao so precisa do que e falado no video. Enviar o video
// inteiro para a IA custa ~258 tokens por segundo (frames + audio), enquanto o
// audio isolado custa ~32 tokens por segundo, alem de reduzir drasticamente os
// bytes de upload. Por isso todo video passa por aqui antes de ir para a IA.
const DEFAULT_AUDIO_MIME_TYPE = "audio/mp3";
const DEFAULT_AUDIO_EXTENSION = ".mp3";
const DEFAULT_AUDIO_CODEC = "libmp3lame";
const DEFAULT_AUDIO_BITRATE = "32k";
const DEFAULT_AUDIO_CHANNELS = 1;
const DEFAULT_AUDIO_SAMPLE_RATE = 16000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function isAudioMimeType(value) {
  return Boolean(value && String(value).toLowerCase().startsWith("audio/"));
}

function resolveFfmpegPath(options = {}) {
  const explicitPath = options.ffmpegPath || process.env.FFMPEG_PATH;

  if (explicitPath) {
    return String(explicitPath).trim();
  }

  try {
    // Binario instalado via npm (@ffmpeg-installer/ffmpeg), evitando depender de
    // um ffmpeg no PATH do servidor.
    return require("@ffmpeg-installer/ffmpeg").path;
  } catch {
    return "ffmpeg";
  }
}

function resolveInputExtension(downloadedVideo) {
  const extension = path.extname(String(downloadedVideo.name || "")).toLowerCase();

  return extension || ".mp4";
}

function resolveAudioFileName(downloadedVideo) {
  const name = String(downloadedVideo.name || "video").trim() || "video";
  const extension = path.extname(name);
  const baseName = extension ? name.slice(0, -extension.length) : name;

  return `${baseName || "video"}${DEFAULT_AUDIO_EXTENSION}`;
}

function buildFfmpegArgs(inputPath, outputPath, options = {}) {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    // -vn descarta a trilha de video; o restante reamostra para mono/16 kHz, que
    // e o suficiente para reconhecimento de fala.
    "-vn",
    "-ac",
    String(options.audioChannels || DEFAULT_AUDIO_CHANNELS),
    "-ar",
    String(options.audioSampleRate || DEFAULT_AUDIO_SAMPLE_RATE),
    "-c:a",
    options.audioCodec || DEFAULT_AUDIO_CODEC,
    "-b:a",
    options.audioBitrate || DEFAULT_AUDIO_BITRATE,
    outputPath,
  ];
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
    // processo e derrubado pelo timeout no meio de um video longo - e a extracao
    // roda dentro da API, entao isso levaria o servidor junto. O desfecho real
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
      if (code === 0) {
        resolve();

        return;
      }

      const details = stderr.trim().split("\n").slice(-5).join(" | ");

      reject(
        new Error(
          `Falha ao extrair audio do video com ffmpeg (code ${code}${signal ? `, signal ${signal}` : ""})${
            details ? `: ${details}` : ""
          }`
        )
      );
    });
  });
}

// Recebe o objeto retornado por downloadFromDrive e devolve o mesmo formato
// (bytes/name/mime_type/metadata), porem contendo apenas o audio do video.
// Quando o arquivo ja e audio, retorna o proprio objeto sem reprocessar.
async function extractAudioFromVideo(downloadedVideo, options = {}) {
  if (!downloadedVideo || !Buffer.isBuffer(downloadedVideo.bytes) || downloadedVideo.bytes.length === 0) {
    throw new Error("Bytes do video sao obrigatorios para extrair o audio");
  }

  if (isAudioMimeType(downloadedVideo.mime_type)) {
    return downloadedVideo;
  }

  const ffmpegPath = resolveFfmpegPath(options);
  const workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "estimulo-audio-"));
  const inputPath = path.join(workingDirectory, `input${resolveInputExtension(downloadedVideo)}`);
  const outputPath = path.join(workingDirectory, `output${DEFAULT_AUDIO_EXTENSION}`);

  try {
    await fs.writeFile(inputPath, downloadedVideo.bytes);
    await runFfmpeg(ffmpegPath, buildFfmpegArgs(inputPath, outputPath, options), options);

    const audioBytes = await fs.readFile(outputPath);

    if (!audioBytes.length) {
      throw new Error("Extracao de audio gerou arquivo vazio (o video possui trilha de audio?)");
    }

    const name = resolveAudioFileName(downloadedVideo);

    return {
      ...downloadedVideo,
      bytes: audioBytes,
      name,
      mime_type: DEFAULT_AUDIO_MIME_TYPE,
      file_extension: DEFAULT_AUDIO_EXTENSION.replace(/^\./, ""),
      source_mime_type: downloadedVideo.mime_type,
      source_size_bytes: downloadedVideo.bytes.length,
      metadata: {
        ...(downloadedVideo.metadata || {}),
        name,
        mime_type: DEFAULT_AUDIO_MIME_TYPE,
        size_bytes: audioBytes.length,
        source_mime_type: downloadedVideo.mime_type,
        source_size_bytes: downloadedVideo.bytes.length,
      },
    };
  } finally {
    await fs.rm(workingDirectory, { force: true, recursive: true }).catch(() => {});
  }
}

module.exports = {
  DEFAULT_AUDIO_BITRATE,
  DEFAULT_AUDIO_CHANNELS,
  DEFAULT_AUDIO_CODEC,
  DEFAULT_AUDIO_MIME_TYPE,
  DEFAULT_AUDIO_SAMPLE_RATE,
  buildFfmpegArgs,
  extractAudioFromVideo,
  isAudioMimeType,
  resolveAudioFileName,
  resolveFfmpegPath,
};
