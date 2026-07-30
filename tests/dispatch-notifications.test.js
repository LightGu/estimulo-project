const assert = require("node:assert/strict");

const { closeQueueInfrastructure } = require("../src/queues/bullmq");
const { DISPATCH_FAILED_STATUS, buildDispatchJobData, createDispatchProcessor } = require("../src/queues/dispatch");

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

function buildFailingJobData(overrides = {}) {
  return buildDispatchJobData({
    group_id: "120363000000000000@g.us",
    campaign_id: "campaign-1",
    video_id: "video-1",
    link_video: "https://example.com/video.mp4",
    legenda: "Legenda de teste",
    scheduled_at: "2026-07-14T10:00:00.000Z",
    ...overrides,
  });
}

async function testDispatchFailureNotifiesOnce() {
  const notifyFailureCalls = [];
  const jobData = buildFailingJobData();
  const job = createFakeJob(jobData);
  const processor = createDispatchProcessor({
    sender: async () => {
      throw new Error("Evolution indisponivel");
    },
    campaignsRepository: { findById: async () => ({ id: "campaign-1", trilha: "Trilha X" }) },
    campaignGroupsRepository: { isCampaignFullyTerminal: async () => false },
    notificationsService: {
      notifyDispatchFailure: async (payload) => {
        notifyFailureCalls.push(payload);
        return { sent: true };
      },
      notifyCampaignFinished: async () => {
        throw new Error("nao deveria ser chamado quando a campanha nao esta terminal");
      },
    },
  });

  await assert.rejects(() => processor(job), /Evolution indisponivel/);

  assert.equal(notifyFailureCalls.length, 1);
  assert.equal(notifyFailureCalls[0].campaignId, "campaign-1");
  assert.equal(notifyFailureCalls[0].groupId, "120363000000000000@g.us");
  assert.equal(notifyFailureCalls[0].videoId, "video-1");
  assert.equal(notifyFailureCalls[0].errorMessage, "Evolution indisponivel");

  assert.equal(job.updates[job.updates.length - 1].status, DISPATCH_FAILED_STATUS);
}

async function testDispatchFailureViaConsistencyServiceNotifiesOnce() {
  const notifyFailureCalls = [];
  const jobData = buildDispatchJobData({
    group_id: "22222222-2222-1222-8222-222222222222",
    campaign_id: "11111111-1111-1111-8111-111111111111",
    video_id: "33333333-3333-1333-8333-333333333333",
    progress_group_id: "22222222-2222-1222-8222-222222222222",
    link_video: "https://example.com/video.mp4",
    legenda: "Legenda de teste",
    scheduled_at: "2026-07-14T10:00:00.000Z",
  });
  const job = createFakeJob(jobData);
  const processor = createDispatchProcessor({
    sender: async () => ({ status: 200, data: { success: true } }),
    dispatchConsistencyService: {
      executeDispatch: async () => {
        throw new Error("Falha simulada na consistencia de disparo");
      },
    },
    campaignsRepository: { findById: async () => ({ id: jobData.campaign_id, trilha: "Trilha X" }) },
    campaignGroupsRepository: { isCampaignFullyTerminal: async () => false },
    notificationsService: {
      notifyDispatchFailure: async (payload) => {
        notifyFailureCalls.push(payload);
        return { sent: true };
      },
      notifyCampaignFinished: async () => {
        throw new Error("nao deveria ser chamado quando a campanha nao esta terminal");
      },
    },
  });

  await assert.rejects(() => processor(job), /Falha simulada na consistencia de disparo/);

  assert.equal(notifyFailureCalls.length, 1);
}

async function testDispatchSuccessNotifiesCampaignFinishedWhenTerminal() {
  const notifyFinishedCalls = [];
  const jobData = buildFailingJobData();
  const job = createFakeJob(jobData);
  const processor = createDispatchProcessor({
    sender: async () => ({ status: 200, data: { success: true } }),
    campaignsRepository: { findById: async () => ({ id: "campaign-1", trilha: "Trilha X" }) },
    campaignGroupsRepository: { isCampaignFullyTerminal: async () => true },
    notificationsService: {
      notifyCampaignFinished: async (payload) => {
        notifyFinishedCalls.push(payload);
        return { sent: true };
      },
    },
  });

  await processor(job);

  assert.equal(notifyFinishedCalls.length, 1);
  assert.equal(notifyFinishedCalls[0].campaignId, "campaign-1");
  assert.equal(notifyFinishedCalls[0].campaignLabel, "Trilha X");
}

async function testDispatchSuccessSkipsNotificationWhenNotTerminal() {
  let notifyFinishedCalled = false;
  const jobData = buildFailingJobData();
  const job = createFakeJob(jobData);
  const processor = createDispatchProcessor({
    sender: async () => ({ status: 200, data: { success: true } }),
    campaignsRepository: { findById: async () => ({ id: "campaign-1", trilha: "Trilha X" }) },
    campaignGroupsRepository: { isCampaignFullyTerminal: async () => false },
    notificationsService: {
      notifyCampaignFinished: async () => {
        notifyFinishedCalled = true;
        return { sent: true };
      },
    },
  });

  await processor(job);

  assert.equal(notifyFinishedCalled, false);
}

async function testDispatchSuccessNotifiesTrailFinishedWhenNoNextVideo() {
  const trailFinishedCalls = [];
  const jobData = buildDispatchJobData({
    group_id: "120363000000000000@g.us",
    campaign_id: "campaign-1",
    video_id: "video-1",
    progress_group_id: "group-1",
    trilha_id: "trilha-1",
    link_video: "https://example.com/video.mp4",
    legenda: "Legenda de teste",
    scheduled_at: "2026-07-14T10:00:00.000Z",
  });
  const job = createFakeJob(jobData);
  const processor = createDispatchProcessor({
    sender: async () => ({ status: 200, data: { success: true } }),
    progressRepository: {
      hasDuplicate: async () => false,
      registerDelivery: async (payload) => ({ id: "progress-1", ...payload }),
      listDelivered: async () => [{ video_id: "video-1" }],
    },
    groupsRepository: {
      findById: async () => ({ id: "group-1", nome: "Grupo Teste", trilha_id: "trilha-1" }),
      update: async () => ({}),
    },
    trilhasRepository: {
      listVideoLinksByTrilha: async () => [{ video_id: "video-1", ordem: 1 }],
    },
    videoCatalogRepository: {
      listApproved: async () => [{ id: "video-1", status: true, ordem: 1 }],
    },
    campaignsRepository: { findById: async () => ({ id: "campaign-1", trilha: "Trilha X" }) },
    campaignGroupsRepository: { isCampaignFullyTerminal: async () => false },
    notificationsService: {
      notifyCampaignFinished: async () => ({ sent: true }),
    },
    inAppNotificationsService: {
      notifyTrailFinished: async (payload) => {
        trailFinishedCalls.push(payload);
        return { sent: true };
      },
    },
  });

  await processor(job);

  assert.equal(trailFinishedCalls.length, 1);
  assert.equal(trailFinishedCalls[0].groupId, "group-1");
  assert.equal(trailFinishedCalls[0].groupName, "Grupo Teste");
}

async function testDispatchSuccessSkipsTrailFinishedWhenNextVideoExists() {
  let trailFinishedCalled = false;
  const jobData = buildDispatchJobData({
    group_id: "120363000000000000@g.us",
    campaign_id: "campaign-1",
    video_id: "video-1",
    progress_group_id: "group-1",
    trilha_id: "trilha-1",
    link_video: "https://example.com/video.mp4",
    legenda: "Legenda de teste",
    scheduled_at: "2026-07-14T10:00:00.000Z",
  });
  const job = createFakeJob(jobData);
  const processor = createDispatchProcessor({
    sender: async () => ({ status: 200, data: { success: true } }),
    progressRepository: {
      hasDuplicate: async () => false,
      registerDelivery: async (payload) => ({ id: "progress-1", ...payload }),
      listDelivered: async () => [{ video_id: "video-1" }],
    },
    groupsRepository: {
      findById: async () => ({ id: "group-1", nome: "Grupo Teste", trilha_id: "trilha-1" }),
      update: async () => ({}),
    },
    trilhasRepository: {
      listVideoLinksByTrilha: async () => [
        { video_id: "video-1", ordem: 1 },
        { video_id: "video-2", ordem: 2 },
      ],
    },
    videoCatalogRepository: {
      listApproved: async () => [
        { id: "video-1", status: true, ordem: 1 },
        { id: "video-2", status: true, ordem: 2 },
      ],
    },
    campaignsRepository: { findById: async () => ({ id: "campaign-1", trilha: "Trilha X" }) },
    campaignGroupsRepository: { isCampaignFullyTerminal: async () => false },
    notificationsService: {
      notifyCampaignFinished: async () => ({ sent: true }),
    },
    inAppNotificationsService: {
      notifyTrailFinished: async () => {
        trailFinishedCalled = true;
        return { sent: true };
      },
    },
  });

  await processor(job);

  assert.equal(trailFinishedCalled, false);
}

async function testDispatchSuccessSkipsTrailFinishedOnDuplicateProgress() {
  let trailFinishedCalled = false;
  const jobData = buildDispatchJobData({
    group_id: "120363000000000000@g.us",
    campaign_id: "campaign-1",
    video_id: "video-1",
    progress_group_id: "group-1",
    trilha_id: "trilha-1",
    never_repeat_video: true,
    link_video: "https://example.com/video.mp4",
    legenda: "Legenda de teste",
    scheduled_at: "2026-07-14T10:00:00.000Z",
  });
  const job = createFakeJob(jobData);
  const processor = createDispatchProcessor({
    sender: async () => ({ status: 200, data: { success: true } }),
    progressRepository: {
      hasDuplicate: async () => true,
      listDelivered: async () => [{ video_id: "video-1" }],
    },
    groupsRepository: {
      findById: async () => ({ id: "group-1", nome: "Grupo Teste", trilha_id: "trilha-1" }),
      update: async () => ({}),
    },
    trilhasRepository: {
      listVideoLinksByTrilha: async () => [{ video_id: "video-1", ordem: 1 }],
    },
    videoCatalogRepository: {
      listApproved: async () => [{ id: "video-1", status: true, ordem: 1 }],
    },
    campaignsRepository: { findById: async () => ({ id: "campaign-1", trilha: "Trilha X" }) },
    campaignGroupsRepository: { isCampaignFullyTerminal: async () => false },
    notificationsService: {
      notifyCampaignFinished: async () => ({ sent: true }),
    },
    inAppNotificationsService: {
      notifyTrailFinished: async () => {
        trailFinishedCalled = true;
        return { sent: true };
      },
    },
  });

  await processor(job);

  assert.equal(trailFinishedCalled, false);
}

async function testTrailFinishedNotificationFailureDoesNotBreakDispatchFlow() {
  const jobData = buildDispatchJobData({
    group_id: "120363000000000000@g.us",
    campaign_id: "campaign-1",
    video_id: "video-1",
    progress_group_id: "group-1",
    trilha_id: "trilha-1",
    link_video: "https://example.com/video.mp4",
    legenda: "Legenda de teste",
    scheduled_at: "2026-07-14T10:00:00.000Z",
  });
  const job = createFakeJob(jobData);
  const processor = createDispatchProcessor({
    sender: async () => ({ status: 200, data: { success: true } }),
    progressRepository: {
      hasDuplicate: async () => false,
      registerDelivery: async (payload) => ({ id: "progress-1", ...payload }),
      listDelivered: async () => [{ video_id: "video-1" }],
    },
    groupsRepository: {
      findById: async () => ({ id: "group-1", nome: "Grupo Teste", trilha_id: "trilha-1" }),
      update: async () => ({}),
    },
    trilhasRepository: {
      listVideoLinksByTrilha: async () => [{ video_id: "video-1", ordem: 1 }],
    },
    videoCatalogRepository: {
      listApproved: async () => [{ id: "video-1", status: true, ordem: 1 }],
    },
    campaignsRepository: { findById: async () => ({ id: "campaign-1", trilha: "Trilha X" }) },
    campaignGroupsRepository: { isCampaignFullyTerminal: async () => false },
    notificationsService: {
      notifyCampaignFinished: async () => ({ sent: true }),
    },
    inAppNotificationsService: {
      notifyTrailFinished: async () => {
        throw new Error("erro ao notificar trilha concluida");
      },
    },
  });

  await processor(job);
}

async function testNotificationFailureDoesNotBreakDispatchFlow() {
  const jobData = buildFailingJobData();
  const job = createFakeJob(jobData);
  const processor = createDispatchProcessor({
    sender: async () => {
      throw new Error("erro original de envio");
    },
    campaignsRepository: { findById: async () => ({ id: "campaign-1", trilha: "Trilha X" }) },
    campaignGroupsRepository: {
      isCampaignFullyTerminal: async () => {
        throw new Error("erro ao checar status da campanha");
      },
    },
    notificationsService: {
      notifyDispatchFailure: async () => {
        throw new Error("erro ao notificar falha");
      },
      notifyCampaignFinished: async () => {
        throw new Error("nao deveria ser chamado");
      },
    },
  });

  await assert.rejects(() => processor(job), /erro original de envio/);
}

async function main() {
  await testDispatchFailureNotifiesOnce();
  await testDispatchFailureViaConsistencyServiceNotifiesOnce();
  await testDispatchSuccessNotifiesCampaignFinishedWhenTerminal();
  await testDispatchSuccessSkipsNotificationWhenNotTerminal();
  await testDispatchSuccessNotifiesTrailFinishedWhenNoNextVideo();
  await testDispatchSuccessSkipsTrailFinishedWhenNextVideoExists();
  await testDispatchSuccessSkipsTrailFinishedOnDuplicateProgress();
  await testTrailFinishedNotificationFailureDoesNotBreakDispatchFlow();
  await testNotificationFailureDoesNotBreakDispatchFlow();

  console.log("dispatch notifications tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await closeQueueInfrastructure();
});
