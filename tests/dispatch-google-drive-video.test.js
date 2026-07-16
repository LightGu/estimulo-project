const assert = require("node:assert/strict");

const { closeQueueInfrastructure } = require("../src/queues/bullmq");
const {
  DISPATCH_SUCCESS_STATUS,
  buildDispatchJobData,
  createDispatchProcessor,
} = require("../src/queues/dispatch");

function createFakeJob(data) {
  const updates = [];

  return {
    id: "job-1",
    data,
    updates,
    async updateData(nextData) {
      updates.push(nextData);
      this.data = nextData;
    },
  };
}

async function testDispatchDownloadsVideoAndSendsBase64Payload() {
  const sentPayloads = [];
  const downloadCalls = [];
  let downloadedVideoRef;
  const jobData = buildDispatchJobData({
    group_id: "120363000000000000@g.us",
    campaign_id: "campaign-1",
    video_catalog: {
      id: "video-1",
      drive_file_id: "drive-file-1",
      name: "aula-01.mp4",
      mime_type: "video/mp4",
    },
    legenda: "Legenda de teste",
    scheduled_at: "2026-07-14T10:00:00.000Z",
  });
  const job = createFakeJob(jobData);
  const processor = createDispatchProcessor({
    videoDownloader: async (params) => {
      downloadCalls.push(params);

      downloadedVideoRef = {
        video_id: "video-1",
        drive_file_id: "drive-file-1",
        bytes: Buffer.from("video-bytes"),
        name: "aula-01.mp4",
        mime_type: "video/mp4",
      };

      return downloadedVideoRef;
    },
    sender: async (payload) => {
      sentPayloads.push(JSON.parse(JSON.stringify(payload)));

      return {
        provider: "fake",
        status: 200,
      };
    },
  });

  const result = await processor(job);

  assert.equal(downloadCalls.length, 1);
  assert.equal(downloadCalls[0].videoCatalogRecord.drive_file_id, "drive-file-1");
  assert.equal(sentPayloads.length, 1);
  assert.deepEqual(sentPayloads[0], {
    groupId: "120363000000000000@g.us",
    message: "Legenda de teste",
    content: {
      base64: Buffer.from("video-bytes").toString("base64"),
      fileName: "aula-01.mp4",
      mimeType: "video/mp4",
      type: "video",
    },
  });
  assert.equal(result.status, DISPATCH_SUCCESS_STATUS);
  assert.equal(job.updates[0].status, "processing");
  assert.equal(job.updates[1].status, DISPATCH_SUCCESS_STATUS);
  assert.equal(downloadedVideoRef.bytes, undefined);
}

async function testDispatchStillAcceptsLegacyVideoUrl() {
  const jobData = buildDispatchJobData({
    group_id: "120363000000000000@g.us",
    campaign_id: "campaign-1",
    link_video: "https://example.com/video.mp4",
    legenda: "Legenda de teste",
    scheduled_at: "2026-07-14T10:00:00.000Z",
  });
  const payload = [];
  const processor = createDispatchProcessor({
    videoDownloader: async () => {
      throw new Error("nao deveria baixar video quando link_video e usado sozinho");
    },
    sender: async (value) => {
      payload.push(value);
      return { provider: "fake" };
    },
  });

  await processor(createFakeJob(jobData));

  assert.equal(payload[0].content.url, "https://example.com/video.mp4");
}

async function testDispatchDoesNotSendWhenDownloadReturnsEmptyVideo() {
  const jobData = buildDispatchJobData({
    group_id: "120363000000000000@g.us",
    campaign_id: "campaign-1",
    video_id: "video-1",
    legenda: "Legenda de teste",
    scheduled_at: "2026-07-14T10:00:00.000Z",
  });
  const sentPayloads = [];
  const processor = createDispatchProcessor({
    videoDownloader: async () => ({
      video_id: "video-1",
      drive_file_id: "drive-file-1",
      bytes: Buffer.alloc(0),
      name: "aula-01.mp4",
      mime_type: "video/mp4",
    }),
    sender: async (payload) => {
      sentPayloads.push(payload);
      return { provider: "fake" };
    },
  });

  await assert.rejects(() => processor(createFakeJob(jobData)), /video vazio/);
  assert.equal(sentPayloads.length, 0);
}

async function testDispatchDoesNotSendWhenDownloadFails() {
  const jobData = buildDispatchJobData({
    group_id: "120363000000000000@g.us",
    campaign_id: "campaign-1",
    video_id: "video-1",
    legenda: "Legenda de teste",
    scheduled_at: "2026-07-14T10:00:00.000Z",
  });
  const sentPayloads = [];
  const processor = createDispatchProcessor({
    videoDownloader: async () => {
      throw new Error("Falha simulada no download");
    },
    sender: async (payload) => {
      sentPayloads.push(payload);
      return { provider: "fake" };
    },
  });

  await assert.rejects(() => processor(createFakeJob(jobData)), /Falha simulada no download/);
  assert.equal(sentPayloads.length, 0);
}

async function testDispatchRejectsDisabledVideoGroupBeforeJobData() {
  assert.throws(
    () => buildDispatchJobData({
      group_id: "120363000000000000@g.us",
      campaign_id: "campaign-1",
      link_video: "https://example.com/video.mp4",
      legenda: "Legenda de teste",
      envia_video: false,
      scheduled_at: "2026-07-14T10:00:00.000Z",
    }),
    /envia_video=false/
  );
}

async function main() {
  await testDispatchDownloadsVideoAndSendsBase64Payload();
  await testDispatchStillAcceptsLegacyVideoUrl();
  await testDispatchDoesNotSendWhenDownloadReturnsEmptyVideo();
  await testDispatchDoesNotSendWhenDownloadFails();
  await testDispatchRejectsDisabledVideoGroupBeforeJobData();

  console.log("dispatch-google-drive-video tests OK");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueueInfrastructure();
  });
