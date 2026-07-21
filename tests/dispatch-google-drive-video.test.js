const assert = require("node:assert/strict");

const { closeQueueInfrastructure } = require("../src/queues/bullmq");
const {
  DISPATCH_SUCCESS_STATUS,
  buildDispatchJobData,
  createDispatchProcessor,
  prepareDispatchCaptionBeforeQueue,
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

async function testDispatchSelectsUnusedCaptionForVideo() {
  const sentPayloads = [];
  const selectedCaptions = [];
  const markedCaptions = [];
  const jobData = buildDispatchJobData({
    group_id: "120363000000000000@g.us",
    campaign_id: "campaign-1",
    video_catalog: {
      id: "video-1",
      drive_file_id: "drive-file-1",
    },
    legenda: "Legenda fallback",
    scheduled_at: "2026-07-14T10:00:00.000Z",
  });
  const processor = createDispatchProcessor({
    videoDownloader: async () => ({
      video_id: "video-1",
      drive_file_id: "drive-file-1",
      bytes: Buffer.from("video-bytes"),
      name: "aula-01.mp4",
      mime_type: "video/mp4",
    }),
    videoCaptionsService: {
      async selectCaptionForVideo(videoId) {
        selectedCaptions.push(videoId);

        return {
          caption: { id: "caption-1" },
          text: "Legenda variada",
        };
      },
      async markCaptionUsed(captionId, options) {
        markedCaptions.push({ captionId, usedAt: options.usedAt });
      },
    },
    sender: async (payload) => {
      sentPayloads.push(JSON.parse(JSON.stringify(payload)));

      return {
        provider: "fake",
        status: 200,
      };
    },
  });

  await processor(createFakeJob(jobData));

  assert.deepEqual(selectedCaptions, ["video-1"]);
  assert.equal(sentPayloads[0].message, "Legenda variada");
  assert.equal(markedCaptions.length, 1);
  assert.equal(markedCaptions[0].captionId, "caption-1");
  assert.ok(markedCaptions[0].usedAt instanceof Date);
}

async function testDispatchStartsDownloadAndCaptionResolutionInParallel() {
  const order = [];
  let finishDownload;
  const downloadCanFinish = new Promise((resolve) => {
    finishDownload = resolve;
  });
  const jobData = buildDispatchJobData({
    group_id: "120363000000000000@g.us",
    campaign_id: "campaign-1",
    video_catalog: {
      id: "video-1",
      drive_file_id: "drive-file-1",
    },
    legenda: "Legenda fallback",
    scheduled_at: "2026-07-14T10:00:00.000Z",
  });
  const processor = createDispatchProcessor({
    videoDownloader: async () => {
      order.push("download:start");
      await downloadCanFinish;
      order.push("download:done");

      return {
        video_id: "video-1",
        drive_file_id: "drive-file-1",
        bytes: Buffer.from("video-bytes"),
        name: "aula-01.mp4",
        mime_type: "video/mp4",
      };
    },
    videoCaptionsService: {
      async selectCaptionForVideo(videoId, options) {
        order.push("caption:start");
        assert.equal(videoId, "video-1");
        assert.ok(options.downloadedVideo instanceof Promise);

        return {
          caption: { id: "caption-1" },
          text: "Legenda variada",
        };
      },
      async markCaptionUsed() {},
    },
    sender: async () => {
      order.push("send");
      return {
        provider: "fake",
        status: 200,
      };
    },
  });

  const processing = processor(createFakeJob(jobData));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(order, ["download:start", "caption:start"]);

  finishDownload();
  await processing;

  assert.deepEqual(order, ["download:start", "caption:start", "download:done", "send"]);
}

async function testDispatchDoesNotMarkCaptionUsedWhenSendFails() {
  let markedCaption = false;
  const jobData = buildDispatchJobData({
    group_id: "120363000000000000@g.us",
    campaign_id: "campaign-1",
    video_catalog: {
      id: "video-1",
      drive_file_id: "drive-file-1",
    },
    legenda: "Legenda fallback",
    scheduled_at: "2026-07-14T10:00:00.000Z",
  });
  const processor = createDispatchProcessor({
    videoDownloader: async () => ({
      video_id: "video-1",
      drive_file_id: "drive-file-1",
      bytes: Buffer.from("video-bytes"),
      name: "aula-01.mp4",
      mime_type: "video/mp4",
    }),
    videoCaptionsService: {
      async selectCaptionForVideo() {
        return {
          caption: { id: "caption-1" },
          text: "Legenda variada",
        };
      },
      async markCaptionUsed() {
        markedCaption = true;
      },
    },
    sender: async () => {
      throw new Error("Falha simulada no envio");
    },
  });

  await assert.rejects(() => processor(createFakeJob(jobData)), /Falha simulada no envio/);
  assert.equal(markedCaption, false);
}

async function testDispatchRegistersProgressAfterConfirmedSend() {
  const progressCalls = [];
  const jobData = buildDispatchJobData({
    group_id: "120363000000000000@g.us",
    progress_group_id: "group-uuid-1",
    campaign_id: "campaign-1",
    video_catalog: {
      id: "video-1",
      drive_file_id: "drive-file-1",
    },
    legenda: "Legenda de teste",
    scheduled_at: "2026-07-14T10:00:00.000Z",
  });
  const processor = createDispatchProcessor({
    videoDownloader: async () => ({
      video_id: "video-1",
      drive_file_id: "drive-file-1",
      bytes: Buffer.from("video-bytes"),
      name: "aula-01.mp4",
      mime_type: "video/mp4",
    }),
    sender: async () => ({ provider: "fake", status: 200 }),
    progressRepository: {
      hasDuplicate: async (groupId, videoId) => {
        progressCalls.push({ type: "hasDuplicate", groupId, videoId });
        return false;
      },
      registerDelivery: async (payload) => {
        progressCalls.push({ type: "registerDelivery", payload });
        return { id: "progress-1", ...payload };
      },
    },
  });
  const job = createFakeJob(jobData);

  const result = await processor(job);

  assert.deepEqual(progressCalls, [
    { type: "hasDuplicate", groupId: "group-uuid-1", videoId: "video-1" },
    { type: "registerDelivery", payload: { group_id: "group-uuid-1", video_id: "video-1" } },
  ]);
  assert.equal(result.progress.duplicate, false);
  assert.equal(job.updates[1].progress_registered, true);
  assert.equal(job.updates[1].progress_duplicate, false);
}

async function testDispatchDoesNotRegisterProgressWhenSendFails() {
  let progressCalled = false;
  const jobData = buildDispatchJobData({
    group_id: "120363000000000000@g.us",
    progress_group_id: "group-uuid-1",
    campaign_id: "campaign-1",
    video_catalog: {
      id: "video-1",
      drive_file_id: "drive-file-1",
    },
    legenda: "Legenda de teste",
    scheduled_at: "2026-07-14T10:00:00.000Z",
  });
  const processor = createDispatchProcessor({
    videoDownloader: async () => ({
      video_id: "video-1",
      drive_file_id: "drive-file-1",
      bytes: Buffer.from("video-bytes"),
      name: "aula-01.mp4",
      mime_type: "video/mp4",
    }),
    sender: async () => {
      throw new Error("Falha simulada no envio");
    },
    progressRepository: {
      hasDuplicate: async () => {
        progressCalled = true;
        return false;
      },
      registerDelivery: async () => {
        progressCalled = true;
      },
    },
  });

  await assert.rejects(() => processor(createFakeJob(jobData)), /Falha simulada no envio/);
  assert.equal(progressCalled, false);
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

async function testDispatchAcceptsMissingCaption() {
  const jobData = buildDispatchJobData({
    group_id: "120363000000000000@g.us",
    campaign_id: "campaign-1",
    link_video: "https://example.com/video.mp4",
    scheduled_at: "2026-07-14T10:00:00.000Z",
  });
  const payload = [];
  const processor = createDispatchProcessor({
    sender: async (value) => {
      payload.push(value);
      return { provider: "fake" };
    },
  });

  await processor(createFakeJob(jobData));

  assert.equal(jobData.legenda, "");
  assert.equal(payload[0].message, "");
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

async function testPreparesReviewedCaptionBeforeQueueCreation() {
  const calls = [];
  const jobData = buildDispatchJobData({
    group_id: "120363000000000000@g.us",
    campaign_id: "campaign-1",
    video_catalog: {
      id: "video-1",
      drive_file_id: "drive-file-1",
      transcript: "Transcricao do video sobre planejamento financeiro",
    },
    legenda: "Legenda fallback",
    scheduled_at: "2026-07-14T10:00:00.000Z",
  });

  const caption = await prepareDispatchCaptionBeforeQueue(jobData, {
    logger: {},
    videoCaptionsService: {
      async selectCaptionForVideo(videoId, options) {
        calls.push({ videoId, transcript: options.transcript, requireCaptionReview: options.requireCaptionReview });

        return { text: "Legenda aprovada antes do job", caption: { id: "caption-1" }, generated: false };
      },
    },
  });

  assert.equal(caption.text, "Legenda aprovada antes do job");
  assert.equal(caption.caption.id, "caption-1");
  assert.deepEqual(calls, [
    {
      videoId: "video-1",
      transcript: "Transcricao do video sobre planejamento financeiro",
      requireCaptionReview: true,
    },
  ]);
}

async function testRejectedCaptionDoesNotReachSender() {
  const sentPayloads = [];
  const jobData = buildDispatchJobData({
    group_id: "120363000000000000@g.us",
    campaign_id: "campaign-1",
    video_catalog: {
      id: "video-1",
      drive_file_id: "drive-file-1",
      transcript: "Transcricao real",
    },
    legenda: "Legenda inventada",
    scheduled_at: "2026-07-14T10:00:00.000Z",
  });
  const processor = createDispatchProcessor({
    captionReviewService: {
      async assertCaptionApproved() {
        throw new Error("Legenda reprovada: conteudo inventado");
      },
    },
    videoDownloader: async () => ({
      video_id: "video-1",
      drive_file_id: "drive-file-1",
      bytes: Buffer.from("video-bytes"),
      name: "aula-01.mp4",
      mime_type: "video/mp4",
    }),
    sender: async (payload) => {
      sentPayloads.push(payload);
      return { provider: "fake" };
    },
  });

  await assert.rejects(() => processor(createFakeJob(jobData)), /Legenda reprovada/);
  assert.equal(sentPayloads.length, 0);
}

async function main() {
  await testDispatchDownloadsVideoAndSendsBase64Payload();
  await testDispatchSelectsUnusedCaptionForVideo();
  await testDispatchStartsDownloadAndCaptionResolutionInParallel();
  await testDispatchDoesNotMarkCaptionUsedWhenSendFails();
  await testDispatchRegistersProgressAfterConfirmedSend();
  await testDispatchDoesNotRegisterProgressWhenSendFails();
  await testDispatchStillAcceptsLegacyVideoUrl();
  await testDispatchAcceptsMissingCaption();
  await testDispatchDoesNotSendWhenDownloadReturnsEmptyVideo();
  await testDispatchDoesNotSendWhenDownloadFails();
  await testDispatchRejectsDisabledVideoGroupBeforeJobData();
  await testPreparesReviewedCaptionBeforeQueueCreation();
  await testRejectedCaptionDoesNotReachSender();

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
