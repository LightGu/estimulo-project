const assert = require("node:assert/strict");

const {
  buildCampaignVideoFlowRepository,
  createCampaignTriggerProcessor,
} = require("../src/queues/campaign-trigger");
const { closeQueueInfrastructure } = require("../src/queues/bullmq");

function createJob(data = {}) {
  const updates = [];
  const job = {
    id: "job-1",
    data: {
      campaign_id: "campaign-1",
      execution_at: "2026-07-17T10:00:00.000Z",
      ...data,
    },
    updates,
    async updateData(nextData) {
      updates.push(nextData);
      job.data = nextData;
    },
  };

  return job;
}

function createGroup(overrides = {}) {
  return {
    id: "group-1",
    evolution_group_id: "120363@g.us",
    segmento: "Pre infancia",
    envia_video: true,
    ...overrides,
  };
}

function createVideo(overrides = {}) {
  return {
    id: "video-1",
    drive_file_id: "drive-1",
    etapa: 1,
    trilha_segmento: "Pre infancia",
    status: true,
    legenda: "Legenda do video",
    ...overrides,
  };
}

const fakeCampaignsRepository = {
  findById: async (id) => ({ id, nome: "Pre infancia" }),
};

async function testVideoFlowRepositoryUsesGroupProgress() {
  const repository = buildCampaignVideoFlowRepository({
    videoCatalogRepository: {
      listApproved: async () => [
        createVideo({ id: "video-1", etapa: 1 }),
        createVideo({ id: "video-2", etapa: 2, drive_file_id: "drive-2" }),
      ],
    },
    groupVideoProgressRepository: {
      listDelivered: async (groupId) => {
        assert.equal(groupId, "group-1");

        return [{ video_id: "video-1" }];
      },
    },
  });

  const nextVideo = await repository.findNextApprovedUnsentVideoForGroup(createGroup());

  assert.equal(nextVideo.id, "video-2");
}

async function testProcessorFiltersVideoEnabledGroupsAndEnqueuesDispatch() {
  const dispatchJobs = [];
  const processor = createCampaignTriggerProcessor({
    logger: {},
    campaigns: fakeCampaignsRepository,
    dispatchLogs: null,
    campaignGroups: {
      listGroups: async (campaignId) => {
        assert.equal(campaignId, "campaign-1");

        return [
          { groups: createGroup({ id: "group-1", evolution_group_id: "enabled@g.us", envia_video: true }) },
          { groups: createGroup({ id: "group-2", evolution_group_id: "disabled@g.us", envia_video: false }) },
        ];
      },
    },
    videoFlowRepository: {
      findNextApprovedUnsentVideoForGroup: async (group) => {
        assert.equal(group.id, "group-1");

        return createVideo({ id: "video-1", drive_file_id: "drive-1" });
      },
    },
    addDispatchJob: async (payload) => {
      dispatchJobs.push(payload);

      return { id: `dispatch-${dispatchJobs.length}`, data: payload };
    },
  });
  const job = createJob();

  const result = await processor(job);

  assert.equal(dispatchJobs.length, 1);
  assert.equal(dispatchJobs[0].group_id, "enabled@g.us");
  assert.equal(dispatchJobs[0].progress_group_id, "group-1");
  assert.equal(dispatchJobs[0].campaign_id, "campaign-1");
  assert.equal(dispatchJobs[0].video_id, "video-1");
  assert.equal(dispatchJobs[0].drive_file_id, "drive-1");
  assert.equal(dispatchJobs[0].legenda, "Legenda do video");
  assert.equal(result.total_campaign_groups, 2);
  assert.equal(result.video_enabled_groups, 1);
  assert.equal(result.dispatch_enqueued, 1);
  assert.equal(job.updates[0].status, "processing");
  assert.equal(job.updates[1].status, "completed");
}

async function testProcessorUsesJitteredDispatchWhenWindowAndJitterArePresent() {
  const jitterCalls = [];
  const campaignUpdates = [];
  const processor = createCampaignTriggerProcessor({
    logger: {},
    campaigns: {
      findById: fakeCampaignsRepository.findById,
      update: async (id, payload) => {
        campaignUpdates.push({ id, payload });
        return { id, ...payload };
      },
    },
    dispatchLogs: null,
    campaignGroups: {
      listGroups: async () => [
        { groups: createGroup({ id: "group-1", evolution_group_id: "group-1@g.us" }) },
      ],
    },
    videoFlowRepository: {
      findNextApprovedUnsentVideoForGroup: async () => createVideo(),
    },
    addJitteredDispatchJobs: async (payload) => {
      jitterCalls.push(payload);

      return [{ id: "dispatch-1", data: { scheduled_at: "2026-07-17T12:01:00.000Z" } }];
    },
  });
  const job = createJob({
    time_window: { start: "09:00", end: "10:00" },
    dispatch_jitter: { min_ms: 1000, max_ms: 2000 },
  });

  const result = await processor(job);

  assert.equal(jitterCalls.length, 1);
  assert.equal(jitterCalls[0].groups.length, 1);
  assert.equal(jitterCalls[0].jitter_delay_min_ms, 1000);
  assert.equal(jitterCalls[0].jitter_delay_max_ms, 2000);
  assert.deepEqual(campaignUpdates, [
    {
      id: "campaign-1",
      payload: {
        ativo: true,
        data_envio: "2026-07-17",
        horario_envio: "09:01:00",
      },
    },
  ]);
  assert.equal(result.dispatch_enqueued, 1);
}

async function testProcessorUsesCampaignNameAsTrailFallback() {
  const dispatchJobs = [];
  const processor = createCampaignTriggerProcessor({
    logger: {},
    campaigns: {
      findById: async () => ({ id: "campaign-1", nome: "Trilha Campanha" }),
    },
    dispatchLogs: null,
    campaignGroups: {
      listGroups: async () => [
        { groups: createGroup({ id: "group-1", evolution_group_id: "group-1@g.us", segmento: "Outro" }) },
      ],
    },
    videoFlowRepository: {
      findNextApprovedUnsentVideoForGroup: async (group) => {
        assert.equal(group.trilha_override, "Trilha Campanha");

        return createVideo({ trilha: "Trilha Campanha" });
      },
    },
    addDispatchJob: async (payload) => {
      dispatchJobs.push(payload);

      return { id: "dispatch-1", data: payload };
    },
  });

  await processor(createJob());

  assert.equal(dispatchJobs.length, 1);
}

async function testProcessorCreatesPendingDispatchLogAfterEnqueue() {
  const createdLogs = [];
  const processor = createCampaignTriggerProcessor({
    logger: {},
    campaigns: fakeCampaignsRepository,
    dispatchLogs: {
      listByCampaign: async (campaignId) => {
        assert.equal(campaignId, "campaign-1");

        return [];
      },
      createLog: async (payload) => {
        const record = { id: `log-${createdLogs.length + 1}`, ...payload };
        createdLogs.push(record);
        return record;
      },
    },
    campaignGroups: {
      listGroups: async () => [
        { groups: createGroup({ id: "group-1", evolution_group_id: "enabled@g.us" }) },
      ],
    },
    videoFlowRepository: {
      findNextApprovedUnsentVideoForGroup: async () => createVideo({ id: "video-1", drive_file_id: "drive-1" }),
    },
    addDispatchJob: async (payload) => ({ id: "dispatch-1", data: payload }),
  });

  const result = await processor(createJob());

  assert.equal(result.pending_logs_created, 1);
  assert.deepEqual(createdLogs, [
    {
      id: "log-1",
      campaign_id: "campaign-1",
      group_id: "group-1",
      video_id: "video-1",
      status: "pendente",
      mensagem_erro: null,
    },
  ]);
}

async function main() {
  await testVideoFlowRepositoryUsesGroupProgress();
  await testProcessorFiltersVideoEnabledGroupsAndEnqueuesDispatch();
  await testProcessorUsesJitteredDispatchWhenWindowAndJitterArePresent();
  await testProcessorUsesCampaignNameAsTrailFallback();
  await testProcessorCreatesPendingDispatchLogAfterEnqueue();

  console.log("campaign-trigger-processor tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await closeQueueInfrastructure();
});
