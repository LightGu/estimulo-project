const assert = require("node:assert/strict");

const {
  createVideoCaptionsService,
  getStartOfTodayInTimeZone,
  normalizeCaptionText,
} = require("../src/services/video-captions.service");

async function testSelectsAndMarksUnusedCaption() {
  const calls = [];
  const service = createVideoCaptionsService({
    repository: {
      async listUnusedTodayByVideo(videoId, todayStart) {
        calls.push({ type: "list", videoId, todayStart: todayStart.toISOString() });

        return [
          {
            id: "caption-1",
            video_id: videoId,
            caption_text: " Legenda nova ",
            ultimo_uso_em: null,
          },
        ];
      },
      async markUsed(id, usedAt) {
        calls.push({ type: "mark", id, usedAt: usedAt.toISOString() });

        return {
          id,
          caption_text: " Legenda nova ",
          ultimo_uso_em: usedAt.toISOString(),
        };
      },
    },
    timeZone: "America/Bahia",
  });

  const selected = await service.selectCaptionForVideo("video-1", {
    now: new Date("2026-07-21T15:00:00.000Z"),
  });

  assert.equal(selected.text, "Legenda nova");
  assert.deepEqual(calls, [
    { type: "list", videoId: "video-1", todayStart: "2026-07-21T03:00:00.000Z" },
    { type: "mark", id: "caption-1", usedAt: "2026-07-21T15:00:00.000Z" },
  ]);
}

async function testReturnsNullWhenNoUnusedCaptionExists() {
  let marked = false;
  const service = createVideoCaptionsService({
    repository: {
      async listUnusedTodayByVideo() {
        return [];
      },
      async markUsed() {
        marked = true;
      },
    },
  });

  const selected = await service.selectCaptionForVideo("video-1");

  assert.equal(selected, null);
  assert.equal(marked, false);
}

async function main() {
  assert.equal(normalizeCaptionText({ caption_text: " Texto " }), "Texto");
  assert.equal(
    getStartOfTodayInTimeZone(new Date("2026-07-21T15:00:00.000Z"), "America/Bahia").toISOString(),
    "2026-07-21T03:00:00.000Z"
  );

  await testSelectsAndMarksUnusedCaption();
  await testReturnsNullWhenNoUnusedCaptionExists();

  console.log("video-captions-service tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
