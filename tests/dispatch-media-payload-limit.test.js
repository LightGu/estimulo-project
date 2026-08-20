const assert = require("node:assert/strict");

process.env.EVOLUTION_API_MAX_MEDIA_PAYLOAD_BYTES = String(1024 * 1024);

const {
  fitDownloadedVideoToEvolutionLimit,
  resolveDispatchMediaBase64Budget,
} = require("../src/queues/dispatch");
const { base64Length } = require("../src/services/video-compression");
const { isPermanentFailureMessage } = require("../src/queues/dispatch-failure-retry");

const silentLogger = { info() {}, warn() {}, error() {} };

function buildVideo(byteLength) {
  return {
    video_id: "video-1",
    bytes: Buffer.alloc(byteLength, 1),
    name: "video.mov",
    mime_type: "video/quicktime",
  };
}

function testBudgetLeavesRoomForJsonEnvelope() {
  const budget = resolveDispatchMediaBase64Budget({ maxMediaPayloadBytes: 1024 * 1024 });

  assert.ok(budget < 1024 * 1024, "o orcamento de base64 deve descontar o envelope do JSON");
  assert.equal(resolveDispatchMediaBase64Budget({ maxMediaPayloadBytes: 0 }), null);
  assert.equal(resolveDispatchMediaBase64Budget({}), null);
}

async function testKeepsVideoThatAlreadyFits() {
  const config = { maxMediaPayloadBytes: 1024 * 1024 };
  const video = { video_id: "video-1", bytes: Buffer.alloc(1024, 1), name: "video.mp4", mime_type: "video/mp4" };
  let called = false;
  const result = await fitDownloadedVideoToEvolutionLimit(video, {
    config,
    logger: silentLogger,
    compressVideo() {
      called = true;
    },
  });

  assert.equal(result, video);
  assert.equal(called, false, "video mp4 dentro do limite nao deve passar pelo ffmpeg");
  assert.ok(Buffer.isBuffer(video.bytes), "os bytes do video original devem continuar disponiveis");
}

async function testNormalizesNonMp4ContainerRegardlessOfSize() {
  const config = { maxMediaPayloadBytes: 1024 * 1024 };
  const video = buildVideo(1024);
  const normalizedBytes = Buffer.alloc(900, 3);
  let receivedVideo = null;

  const result = await fitDownloadedVideoToEvolutionLimit(video, {
    config,
    logger: silentLogger,
    normalizeContainer(downloadedVideo) {
      receivedVideo = downloadedVideo;

      return { ...downloadedVideo, bytes: normalizedBytes, mime_type: "video/mp4", remuxed: true };
    },
    compressVideo() {
      throw new Error("nao deveria recomprimir um video que ja cabe apos o remux");
    },
  });

  assert.equal(receivedVideo, video, "o video .mov original deve ser oferecido a normalizacao de container");
  assert.equal(result.bytes, normalizedBytes);
  assert.equal(result.mime_type, "video/mp4");
  assert.equal(video.bytes, undefined, "os bytes originais devem ser liberados apos o remux");
}

// Fixture ja em mp4 para exercitar so o corte por tamanho, sem envolver o
// passo de normalizacao de container (coberto em testNormalizesNonMp4ContainerRegardlessOfSize).
function buildMp4Video(byteLength) {
  return {
    video_id: "video-1",
    bytes: Buffer.alloc(byteLength, 1),
    name: "video.mp4",
    mime_type: "video/mp4",
  };
}

async function testCompressesVideoAboveBudgetAndFreesOriginalBytes() {
  const config = { maxMediaPayloadBytes: 1024 * 1024 };
  const video = buildMp4Video(900 * 1024);
  const originalByteLength = video.bytes.length;

  assert.ok(
    base64Length(originalByteLength) > config.maxMediaPayloadBytes,
    "o cenario exige um video que estoure o limite apenas depois do base64"
  );

  const compressedBytes = Buffer.alloc(300 * 1024, 2);
  let receivedBudget = null;
  const result = await fitDownloadedVideoToEvolutionLimit(video, {
    config,
    logger: silentLogger,
    compressVideo(downloadedVideo, options) {
      receivedBudget = options.maxBase64Bytes;

      return { ...downloadedVideo, bytes: compressedBytes, compressed: true };
    },
  });

  assert.equal(result.bytes, compressedBytes);
  assert.equal(result.compressed, true);
  assert.equal(receivedBudget, resolveDispatchMediaBase64Budget(config));
  assert.equal(video.bytes, undefined, "os bytes originais devem ser liberados apos a recompressao");
}

async function testCompressionCanBeDisabledByEnv() {
  const config = { maxMediaPayloadBytes: 1024 * 1024 };
  const video = buildMp4Video(900 * 1024);
  let called = false;

  process.env.EVOLUTION_MEDIA_COMPRESSION_ENABLED = "false";

  try {
    const result = await fitDownloadedVideoToEvolutionLimit(video, {
      config,
      logger: silentLogger,
      compressVideo() {
        called = true;
      },
    });

    assert.equal(result, video);
    assert.equal(called, false);
  } finally {
    delete process.env.EVOLUTION_MEDIA_COMPRESSION_ENABLED;
  }
}

async function testNonMp4ContainerNormalizationCanBeDisabledByEnv() {
  const config = { maxMediaPayloadBytes: 1024 * 1024 };
  const video = buildVideo(1024);
  let called = false;

  process.env.EVOLUTION_MEDIA_COMPRESSION_ENABLED = "false";

  try {
    const result = await fitDownloadedVideoToEvolutionLimit(video, {
      config,
      logger: silentLogger,
      normalizeContainer() {
        called = true;
      },
    });

    assert.equal(result, video);
    assert.equal(called, false);
  } finally {
    delete process.env.EVOLUTION_MEDIA_COMPRESSION_ENABLED;
  }
}

// 413 nao muda de resultado com reenvio identico: antes o sweep gastava 3 retries
// por falha, cada um rebaixando ~125 MB do Drive para montar o mesmo payload.
function testPermanentFailureDetection() {
  assert.equal(
    isPermanentFailureMessage("Falha na chamada para Evolution API (HTTP 413: Internal Server Error)"),
    true
  );
  assert.equal(isPermanentFailureMessage("Payload de midia com 174000000 bytes excede o limite"), true);
  assert.equal(isPermanentFailureMessage("request entity too large"), true);

  assert.equal(isPermanentFailureMessage("Evolution API indisponivel ou sem resposta"), false);
  assert.equal(isPermanentFailureMessage("Tempo limite excedido aguardando resposta da Evolution API"), false);
  assert.equal(isPermanentFailureMessage("Falha na chamada para Evolution API (HTTP 500: erro interno)"), false);
  assert.equal(isPermanentFailureMessage("Falha na chamada para Evolution API (HTTP 429: rate limit)"), false);
  assert.equal(isPermanentFailureMessage(null), false);
}

(async () => {
  testBudgetLeavesRoomForJsonEnvelope();
  await testKeepsVideoThatAlreadyFits();
  await testNormalizesNonMp4ContainerRegardlessOfSize();
  await testCompressesVideoAboveBudgetAndFreesOriginalBytes();
  await testCompressionCanBeDisabledByEnv();
  await testNonMp4ContainerNormalizationCanBeDisabledByEnv();
  testPermanentFailureDetection();

  console.log("dispatch media payload limit tests OK");
})();
