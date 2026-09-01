const assert = require("node:assert/strict");

// Alvo pequeno (64 KB crus) para as fixtures nao precisarem alocar 16 MB. Tem que
// ser definido antes do require: config/evolution.js le o env no carregamento.
process.env.ADHOC_VIDEO_TARGET_BYTES = String(64 * 1024);

const { prepareAdHocMediaContent, resolveAdHocVideoBase64Budget } = require("../src/services/adhoc-media");
const {
  DEFAULT_AUDIO_BITRATE_KBPS,
  DEFAULT_MIN_VIDEO_BITRATE_KBPS,
  base64Length,
  resolveVideoBitrateKbps,
} = require("../src/services/video-compression");

const silentLogger = { info() {}, warn() {}, error() {} };

function buildVideoContent(byteLength, { mimeType = "video/mp4", fileName = "video.mp4" } = {}) {
  return {
    base64: Buffer.alloc(byteLength, 1).toString("base64"),
    mimeType,
    fileName,
    type: "video",
  };
}

function failingCompressor(reason) {
  return () => {
    throw new Error(reason);
  };
}

function testBudgetConvertsRawTargetToBase64() {
  const budget = resolveAdHocVideoBase64Budget({ adhocVideoTargetBytes: 16 * 1024 * 1024 });

  assert.equal(budget, base64Length(16 * 1024 * 1024), "o alvo em bytes crus deve virar orcamento de base64");
  assert.equal(resolveAdHocVideoBase64Budget({ adhocVideoTargetBytes: 0 }), null);
  assert.equal(resolveAdHocVideoBase64Budget({}), null);
}

async function testImageIsNeverPrepared() {
  const content = { base64: Buffer.from("imagem").toString("base64"), mimeType: "image/png", fileName: "a.png", type: "image" };

  const result = await prepareAdHocMediaContent(content, {
    logger: silentLogger,
    compressVideo: failingCompressor("imagem nao deve ser recomprimida"),
    normalizeContainer: failingCompressor("imagem nao deve ser remuxada"),
  });

  assert.equal(result, content, "imagem deve passar intacta pelo pipeline de video");
}

async function testMissingContentIsPassedThrough() {
  const result = await prepareAdHocMediaContent(null, { logger: silentLogger });

  assert.equal(result, null, "ausencia de midia nao deve quebrar o preparo");
}

async function testSmallMp4VideoIsNotTouched() {
  const content = buildVideoContent(1024);

  const result = await prepareAdHocMediaContent(content, {
    logger: silentLogger,
    compressVideo: failingCompressor("video dentro do alvo nao deve passar pelo ffmpeg"),
    normalizeContainer: failingCompressor("mp4 nao deve ser remuxado"),
  });

  assert.equal(result, content, "mp4 dentro do alvo deve ser devolvido sem alteracao");
}

// .mov chega na Evolution com HTTP 200 mas nao aparece no grupo, entao precisa
// virar mp4 mesmo quando o tamanho ja cabe.
async function testMovIsNormalizedEvenWhenSmall() {
  const content = buildVideoContent(1024, { mimeType: "video/quicktime", fileName: "video.mov" });
  const normalizedBytes = Buffer.alloc(900, 3);
  let receivedMimeType = null;

  const result = await prepareAdHocMediaContent(content, {
    logger: silentLogger,
    normalizeContainer(video) {
      receivedMimeType = video.mime_type;

      return { ...video, bytes: normalizedBytes, mime_type: "video/mp4", name: "video.mp4" };
    },
    compressVideo: failingCompressor("nao deve recomprimir um .mov que ja cabe apos o remux"),
  });

  assert.equal(receivedMimeType, "video/quicktime", "o .mov original deve ser oferecido a normalizacao");
  assert.equal(result.mimeType, "video/mp4");
  assert.equal(result.fileName, "video.mp4");
  assert.equal(Buffer.from(result.base64, "base64").length, normalizedBytes.length);
}

async function testLargeVideoIsCompressedToTarget() {
  const originalBytes = 200 * 1024;
  const content = buildVideoContent(originalBytes);
  const compressedBytes = Buffer.alloc(32 * 1024, 7);
  let receivedBudget = null;
  let receivedMaxHeight = null;

  const result = await prepareAdHocMediaContent(content, {
    logger: silentLogger,
    normalizeContainer: failingCompressor("mp4 nao deve ser remuxado"),
    compressVideo(video, options) {
      receivedBudget = options.maxBase64Bytes;
      receivedMaxHeight = options.maxHeight;

      return { ...video, bytes: compressedBytes, mime_type: "video/mp4" };
    },
  });

  assert.equal(receivedBudget, base64Length(64 * 1024), "o compressor deve receber o orcamento derivado do alvo");
  assert.equal(Buffer.from(result.base64, "base64").length, compressedBytes.length);
  assert.equal(result.type, "video");
}

// A resolucao nao pode ser cortada so porque o alvo padrao do modulo de
// compressao e 720p (pensado para o limite antigo de 16 MB) - o Disparador
// Pontual usa um orcamento maior e so quer reduzir bitrate, nao resolucao.
async function testUsaResolucaoMaiorQueOPadraoDoCompressor() {
  const content = buildVideoContent(200 * 1024);
  let receivedMaxHeight = null;

  await prepareAdHocMediaContent(content, {
    logger: silentLogger,
    normalizeContainer: failingCompressor("mp4 nao deve ser remuxado"),
    compressVideo(video, options) {
      receivedMaxHeight = options.maxHeight;

      return { ...video, bytes: Buffer.alloc(1024, 1), mime_type: "video/mp4" };
    },
  });

  assert.equal(receivedMaxHeight, 1080, "o preparo do Disparador Pontual deve pedir 1080p, nao o padrao de 720p");
}

async function testCompressionDisabledSkipsFfmpeg() {
  const previous = process.env.EVOLUTION_MEDIA_COMPRESSION_ENABLED;
  process.env.EVOLUTION_MEDIA_COMPRESSION_ENABLED = "false";

  try {
    const content = buildVideoContent(200 * 1024);

    const result = await prepareAdHocMediaContent(content, {
      logger: silentLogger,
      compressVideo: failingCompressor("compressao desligada nao deve chamar o ffmpeg"),
      normalizeContainer: failingCompressor("compressao desligada nao deve remuxar"),
    });

    assert.equal(result, content, "com a compressao desligada o content passa inalterado");
  } finally {
    if (previous === undefined) {
      delete process.env.EVOLUTION_MEDIA_COMPRESSION_ENABLED;
    } else {
      process.env.EVOLUTION_MEDIA_COMPRESSION_ENABLED = previous;
    }
  }
}

async function testCompressionFailurePropagates() {
  const content = buildVideoContent(200 * 1024);

  await assert.rejects(
    () =>
      prepareAdHocMediaContent(content, {
        logger: silentLogger,
        normalizeContainer: failingCompressor("mp4 nao deve ser remuxado"),
        compressVideo() {
          throw new Error("ffmpeg falhou");
        },
      }),
    /ffmpeg falhou/
  );
}

/*
  Piso de bitrate x duracao.

  resolveVideoBitrateKbps nunca desce abaixo de DEFAULT_MIN_VIDEO_BITRATE_KBPS,
  entao existe uma duracao a partir da qual o alvo e inalcancavel e todas as
  tentativas de ffmpeg produzem o mesmo arquivo. Este teste fixa a fronteira em
  numeros, que e o que o preparo usa para falhar de imediato (com o limite de
  duracao na mensagem) em vez de gastar tres passadas de ffmpeg.
*/
function testPisoDeBitrateDefineDuracaoMaxima() {
  const alvoBytes = 16 * 1024 * 1024;
  const audioKbps = DEFAULT_AUDIO_BITRATE_KBPS;
  const pisoKbps = DEFAULT_MIN_VIDEO_BITRATE_KBPS;

  // Video curto: o bitrate calculado fica acima do piso, entao o alvo manda.
  const curto = resolveVideoBitrateKbps({ targetBytes: alvoBytes, durationSeconds: 60, audioBitrateKbps: audioKbps });
  assert.ok(curto > pisoKbps, "video de 1 min deve usar bitrate acima do piso");

  // Video longo: o piso assume e o arquivo resultante nao cabe mais no alvo.
  const longo = resolveVideoBitrateKbps({ targetBytes: alvoBytes, durationSeconds: 3600, audioBitrateKbps: audioKbps });
  assert.equal(longo, pisoKbps, "video de 1 h deve bater no piso de bitrate");

  const menorTamanhoPossivel = (((pisoKbps + audioKbps) * 1000) / 8) * 3600;
  assert.ok(
    menorTamanhoPossivel > alvoBytes,
    "no piso, 1 h de video nao cabe no alvo - e por isso que o preparo precisa falhar cedo"
  );
}

async function main() {
  testBudgetConvertsRawTargetToBase64();
  await testImageIsNeverPrepared();
  await testMissingContentIsPassedThrough();
  await testSmallMp4VideoIsNotTouched();
  await testMovIsNormalizedEvenWhenSmall();
  await testLargeVideoIsCompressedToTarget();
  await testUsaResolucaoMaiorQueOPadraoDoCompressor();
  await testCompressionDisabledSkipsFfmpeg();
  await testCompressionFailurePropagates();
  testPisoDeBitrateDefineDuracaoMaxima();

  console.log("adhoc-media-compression tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
