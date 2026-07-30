const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  buildFfmpegArgs,
  extractAudioFromVideo,
  isAudioMimeType,
  resolveAudioFileName,
  resolveFfmpegPath,
} = require("../src/services/video-audio-extraction");

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveFfmpegPath(), args, { windowsHide: true });

    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg saiu com code ${code}`))));
  });
}

// Gera um mp4 real (video + audio) usando o proprio binario do ffmpeg, para nao
// precisar versionar um arquivo de midia no repositorio.
async function createSampleVideo() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "estimulo-audio-test-"));
  const videoPath = path.join(directory, "sample.mp4");

  await runFfmpeg([
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=2:size=320x240:rate=15",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    "-shortest",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    videoPath,
  ]);

  return { bytes: await fs.readFile(videoPath), directory };
}

async function testExtractsAudioAndDropsVideoTrack() {
  const sample = await createSampleVideo();

  try {
    const audio = await extractAudioFromVideo({
      video_id: "video-1",
      drive_file_id: "drive-file-1",
      bytes: sample.bytes,
      name: "aula-01.mp4",
      mime_type: "video/mp4",
      metadata: { name: "aula-01.mp4", mime_type: "video/mp4", size_bytes: sample.bytes.length },
    });

    assert.equal(audio.mime_type, "audio/mp3");
    assert.equal(audio.name, "aula-01.mp3");
    assert.equal(audio.file_extension, "mp3");
    assert.equal(audio.video_id, "video-1");
    assert.equal(audio.drive_file_id, "drive-file-1");
    assert.ok(Buffer.isBuffer(audio.bytes) && audio.bytes.length > 0, "audio deve ter bytes");
    assert.ok(
      audio.bytes.length < sample.bytes.length,
      `audio (${audio.bytes.length}) deve ser menor que o video (${sample.bytes.length})`
    );
    assert.equal(audio.source_mime_type, "video/mp4");
    assert.equal(audio.source_size_bytes, sample.bytes.length);
    assert.equal(audio.metadata.mime_type, "audio/mp3");
    assert.equal(audio.metadata.size_bytes, audio.bytes.length);
  } finally {
    await fs.rm(sample.directory, { force: true, recursive: true });
  }
}

async function testKeepsAudioFilesUntouched() {
  const downloadedAudio = { bytes: Buffer.from("already-audio"), mime_type: "audio/mp3", name: "aula-01.mp3" };

  assert.equal(await extractAudioFromVideo(downloadedAudio), downloadedAudio);
  assert.equal(isAudioMimeType("audio/mpeg"), true);
  assert.equal(isAudioMimeType("video/mp4"), false);
}

async function testRejectsEmptyVideo() {
  await assert.rejects(
    () => extractAudioFromVideo({ bytes: Buffer.alloc(0), mime_type: "video/mp4" }),
    /Bytes do video sao obrigatorios/
  );
  await assert.rejects(() => extractAudioFromVideo(null), /Bytes do video sao obrigatorios/);
}

async function testFailsWithClearMessageWhenFfmpegIsMissing() {
  await assert.rejects(
    () =>
      extractAudioFromVideo(
        { bytes: Buffer.from("video-bytes"), mime_type: "video/mp4", name: "aula-01.mp4" },
        { ffmpegPath: path.join(os.tmpdir(), "ffmpeg-que-nao-existe") }
      ),
    /ffmpeg nao encontrado/
  );
}

async function testBuildsAudioOnlyFfmpegArgs() {
  const args = buildFfmpegArgs("in.mp4", "out.mp3");

  assert.ok(args.includes("-vn"), "-vn deve descartar a trilha de video");
  assert.deepEqual(args.slice(-9), [
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "32k",
    "out.mp3",
  ]);
  assert.equal(resolveAudioFileName({ name: "aula.final.mov" }), "aula.final.mp3");
  assert.equal(resolveAudioFileName({}), "video.mp3");
}

async function main() {
  await testExtractsAudioAndDropsVideoTrack();
  await testKeepsAudioFilesUntouched();
  await testRejectsEmptyVideo();
  await testFailsWithClearMessageWhenFfmpegIsMissing();
  await testBuildsAudioOnlyFfmpegArgs();

  console.log("video-audio-extraction tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
