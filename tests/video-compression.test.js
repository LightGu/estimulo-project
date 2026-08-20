const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  base64Length,
  buildCompressionFfmpegArgs,
  compressVideoToFitBase64Budget,
  fitsBase64Budget,
  isMp4Container,
  maxRawBytesForBase64Budget,
  normalizeVideoContainerToMp4,
  parseFfmpegDurationSeconds,
  remuxVideoToMp4,
  resolveCompressedFileName,
  resolveVideoBitrateKbps,
} = require("../src/services/video-compression");
const { resolveFfmpegPath } = require("../src/services/video-audio-extraction");

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveFfmpegPath(), args, { windowsHide: true });

    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg saiu com code ${code}`))));
  });
}

// Gera um mp4 real e proposital-mente "gordo" (bitrate alto) para que a
// recompressao tenha de fato o que reduzir, sem versionar midia no repositorio.
async function createSampleVideo() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "estimulo-compress-test-"));
  const videoPath = path.join(directory, "sample.mp4");

  await runFfmpeg([
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=4:size=640x480:rate=25",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=4",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-qp",
    "0",
    "-c:a",
    "aac",
    "-shortest",
    videoPath,
  ]);

  return { directory, videoPath };
}

function testBase64MathMatchesNodeEncoder() {
  for (const size of [0, 1, 2, 3, 4, 100, 1023, 1024]) {
    assert.equal(base64Length(size), Buffer.alloc(size).toString("base64").length, `tamanho ${size}`);
  }

  // O inverso nunca deve estourar o orcamento informado.
  for (const budget of [4, 100, 1024, 136 * 1024 * 1024]) {
    assert.ok(base64Length(maxRawBytesForBase64Budget(budget)) <= budget, `orcamento ${budget}`);
  }

  assert.equal(fitsBase64Budget(3, 4), true);
  assert.equal(fitsBase64Budget(4, 4), false);
}

function testDurationParsing() {
  assert.equal(parseFfmpegDurationSeconds("  Duration: 00:01:30.50, start: 0.000000"), 90.5);
  assert.equal(parseFfmpegDurationSeconds("Duration: 01:00:00.00"), 3600);
  assert.equal(parseFfmpegDurationSeconds("Duration: N/A, bitrate: N/A"), null);
  assert.equal(parseFfmpegDurationSeconds(""), null);
}

function testBitrateBudgetMath() {
  // 10 MB em 100 s = 800 kbps totais; sobram 800 - 96 para o video.
  assert.equal(
    resolveVideoBitrateKbps({ targetBytes: 10 * 1000 * 1000, durationSeconds: 100, audioBitrateKbps: 96 }),
    704
  );
  // Video muito longo para o orcamento nao pode gerar bitrate zero/negativo.
  assert.equal(resolveVideoBitrateKbps({ targetBytes: 1000, durationSeconds: 3600 }), 300);
}

function testFfmpegArgsEscapeFilterComma() {
  const args = buildCompressionFfmpegArgs("in.mp4", "out.mp4", { videoBitrateKbps: 800, maxHeight: 720 });
  const filter = args[args.indexOf("-vf") + 1];

  // A virgula precisa ir escapada: sem a barra, o ffmpeg le `min(720` e `ih)`
  // como dois filtros distintos e falha ao montar o filtergraph.
  assert.equal(filter, "scale=-2:min(720\\,ih)");
  assert.equal(args[args.indexOf("-b:v") + 1], "800k");
  assert.equal(args[args.indexOf("-maxrate") + 1], "1000k");
  assert.equal(args[args.length - 1], "out.mp4");
}

function testCompressedFileNameKeepsBaseAndForcesMp4() {
  assert.equal(resolveCompressedFileName({ name: "7) Faturamento e lucro.mov" }), "7) Faturamento e lucro.mp4");
  assert.equal(resolveCompressedFileName({ name: "video.mp4" }), "video.mp4");
  assert.equal(resolveCompressedFileName({}), "video.mp4");
}

async function testSkipsFfmpegWhenAlreadyWithinBudget() {
  const downloadedVideo = {
    bytes: Buffer.alloc(300),
    name: "small.mov",
    mime_type: "video/quicktime",
  };
  const result = await compressVideoToFitBase64Budget(downloadedVideo, { maxBase64Bytes: 10 * 1024 });

  assert.equal(result, downloadedVideo, "video que ja cabe deve voltar sem recompressao");
}

async function testRejectsInvalidBudget() {
  await assert.rejects(
    () => compressVideoToFitBase64Budget({ bytes: Buffer.alloc(10) }, { maxBase64Bytes: 0 }),
    /maxBase64Bytes deve ser um numero positivo/
  );
}

async function testCompressesRealVideoIntoBudget() {
  const { directory, videoPath } = await createSampleVideo();

  try {
    const bytes = await fs.readFile(videoPath);
    const maxBase64Bytes = Math.floor(base64Length(bytes.length) / 3);
    const silentLogger = { info() {}, warn() {} };
    const compressed = await compressVideoToFitBase64Budget(
      {
        video_id: "video-de-teste",
        bytes,
        name: "sample.mov",
        mime_type: "video/quicktime",
        metadata: { name: "sample.mov", size_bytes: bytes.length },
      },
      { logger: silentLogger, maxBase64Bytes }
    );

    assert.ok(compressed.bytes.length > 0, "recompressao nao pode gerar arquivo vazio");
    assert.ok(
      base64Length(compressed.bytes.length) <= maxBase64Bytes,
      `base64 do resultado (${base64Length(compressed.bytes.length)}) deve caber em ${maxBase64Bytes}`
    );
    assert.equal(compressed.mime_type, "video/mp4");
    assert.equal(compressed.name, "sample.mp4");
    assert.equal(compressed.compressed, true);
    assert.equal(compressed.source_size_bytes, bytes.length);
    assert.equal(compressed.metadata.size_bytes, compressed.bytes.length);
    // O resultado precisa continuar sendo um mp4 legivel, nao apenas bytes menores.
    assert.equal(compressed.bytes.subarray(4, 8).toString("latin1"), "ftyp");
  } finally {
    await fs.rm(directory, { force: true, recursive: true }).catch(() => {});
  }
}

function testIsMp4Container() {
  assert.equal(isMp4Container({ mime_type: "video/mp4" }), true);
  assert.equal(isMp4Container({ mime_type: "video/quicktime" }), false);
  assert.equal(isMp4Container({}), false);
}

async function testRemuxConvertsMovContainerToMp4WithoutRecoding() {
  const { directory, videoPath } = await createSampleVideo();

  try {
    const bytes = await fs.readFile(videoPath);
    const silentLogger = { info() {}, warn() {} };
    const remuxed = await remuxVideoToMp4(
      { video_id: "video-de-teste", bytes, name: "sample.mov", mime_type: "video/quicktime" },
      { logger: silentLogger }
    );

    assert.ok(remuxed, "remux de um mp4 valido internamente (so container .mov) deve funcionar");
    assert.equal(remuxed.mime_type, "video/mp4");
    assert.equal(remuxed.name, "sample.mp4");
    assert.equal(remuxed.remuxed, true);
    assert.equal(remuxed.source_mime_type, "video/quicktime");
    // -c copy nao recodifica: o tamanho fica proximo ao original (so muda o container).
    assert.ok(
      Math.abs(remuxed.bytes.length - bytes.length) < bytes.length * 0.05,
      "remux nao deve alterar significativamente o tamanho do arquivo"
    );
    assert.equal(remuxed.bytes.subarray(4, 8).toString("latin1"), "ftyp");
  } finally {
    await fs.rm(directory, { force: true, recursive: true }).catch(() => {});
  }
}

async function testRemuxReturnsNullOnInvalidInput() {
  const silentLogger = { info() {}, warn() {} };
  const result = await remuxVideoToMp4(
    { video_id: "video-invalido", bytes: Buffer.from("nao e um video"), name: "broken.mov", mime_type: "video/quicktime" },
    { logger: silentLogger }
  );

  assert.equal(result, null, "remux de bytes invalidos deve falhar sem lancar, para acionar o fallback");
}

async function testNormalizeContainerReturnsInputUnchangedWhenAlreadyMp4() {
  const video = { bytes: Buffer.alloc(10), name: "video.mp4", mime_type: "video/mp4" };
  const result = await normalizeVideoContainerToMp4(video);

  assert.equal(result, video, "video ja em mp4 nao deve passar pelo remux/recompressao");
}

async function testNormalizeContainerPrefersRemuxOverRecompression() {
  const { directory, videoPath } = await createSampleVideo();

  try {
    const bytes = await fs.readFile(videoPath);
    const silentLogger = { info() {}, warn() {} };
    const result = await normalizeVideoContainerToMp4(
      { video_id: "video-de-teste", bytes, name: "sample.mov", mime_type: "video/quicktime" },
      { logger: silentLogger }
    );

    // remuxed=true (nao compressed) confirma que o caminho rapido foi usado,
    // sem passar pela recompressao completa.
    assert.equal(result.remuxed, true);
    assert.equal(result.compressed, undefined);
    assert.equal(result.mime_type, "video/mp4");
  } finally {
    await fs.rm(directory, { force: true, recursive: true }).catch(() => {});
  }
}

// Bytes invalidos nao sao um video valido nem para o remux nem para a
// recompressao: o fallback deve tentar a recompressao (nao silenciar o
// primeiro erro) e propagar o erro dela, em vez de mascarar a falha. O
// buffer precisa estourar o orcamento de base64, senao a recompressao nem
// chega a rodar o ffmpeg (o video "ja cabe" e volta como esta).
async function testNormalizeContainerFallsBackToCompressionWhenRemuxFails() {
  const silentLogger = { info() {}, warn() {} };
  const invalidBytes = Buffer.alloc(2 * 1024, 0);

  await assert.rejects(() =>
    normalizeVideoContainerToMp4(
      { video_id: "video-invalido", bytes: invalidBytes, name: "broken.mov", mime_type: "video/quicktime" },
      { logger: silentLogger, maxBase64Bytes: 100 }
    )
  );
}

(async () => {
  testBase64MathMatchesNodeEncoder();
  testDurationParsing();
  testBitrateBudgetMath();
  testFfmpegArgsEscapeFilterComma();
  testCompressedFileNameKeepsBaseAndForcesMp4();
  testIsMp4Container();
  await testSkipsFfmpegWhenAlreadyWithinBudget();
  await testRejectsInvalidBudget();
  await testCompressesRealVideoIntoBudget();
  await testRemuxConvertsMovContainerToMp4WithoutRecoding();
  await testRemuxReturnsNullOnInvalidInput();
  await testNormalizeContainerReturnsInputUnchangedWhenAlreadyMp4();
  await testNormalizeContainerPrefersRemuxOverRecompression();
  await testNormalizeContainerFallsBackToCompressionWhenRemuxFails();

  console.log("video compression tests OK");
})();
