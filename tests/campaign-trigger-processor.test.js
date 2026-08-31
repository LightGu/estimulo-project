const assert = require("node:assert/strict");

const {
  buildCampaignVideoFlowRepository,
  createCampaignTriggerProcessor,
  enqueueResolvedDispatchJobs,
  ensurePendingDispatchLogs,
} = require("../src/queues/campaign-trigger");
const { closeQueueInfrastructure } = require("../src/queues/bullmq");

// Data relativa ao "agora" do teste, nunca uma data fixa no codigo.
//
// A trava de atraso do trigger (resolveTriggerStaleReason) compara execution_at
// com o horario atual: um execution_at fixo no passado faz o processor pular a
// execucao - correto em producao, mas transformaria estes testes de fluxo em
// falsos negativos que "quebram sozinhos" conforme o calendario anda.
function minutesAgoIso(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function createJob(data = {}) {
  const updates = [];
  const job = {
    id: "job-1",
    data: {
      campaign_id: "campaign-1",
      execution_at: minutesAgoIso(1),
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
    trilha_id: "trilha-1",
    envia_video: true,
    ...overrides,
  };
}

function createVideo(overrides = {}) {
  return {
    id: "video-1",
    drive_file_id: "drive-1",
    etapa: 1,
    status: true,
    legenda: "Legenda do video",
    ...overrides,
  };
}

const fakeCampaignsRepository = {
  findById: async (id) => ({ id, nome: "Pre infancia" }),
};

const noCaptionsRepository = {
  listByCampaign: async () => [],
};

// Nenhum teste deste arquivo cadastra multiplas instancias WhatsApp - o
// comportamento esperado (e o unico exercitado aqui) e o modo legado de
// numero unico, onde nenhum grupo e filtrado e nenhuma instancia e resolvida.
const fakeWhatsappInstancesRepository = {
  listActive: async () => [],
};
const fakeWhatsappInstancesService = {
  filterDispatchableGroups: async (groupIds) => ({ eligible: groupIds, ineligible: [] }),
  getRotationSettings: async () => ({ whatsapp_rotation_group_count: 1 }),
};
const defaultWhatsappTestDependencies = {
  whatsappInstancesRepository: fakeWhatsappInstancesRepository,
  whatsappInstancesService: fakeWhatsappInstancesService,
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
    trilhasRepository: {
      listVideoLinksByTrilha: async (trilhaId) => {
        assert.equal(trilhaId, "trilha-1");

        return [
          { trilha_id: trilhaId, video_id: "video-1", ordem: 1 },
          { trilha_id: trilhaId, video_id: "video-2", ordem: 2 },
        ];
      },
    },
  });

  const nextVideo = await repository.findNextApprovedUnsentVideoForGroup(createGroup());

  assert.equal(nextVideo.id, "video-2");
}

async function testProcessorFiltersVideoEnabledGroupsAndEnqueuesDispatch() {
  const dispatchJobs = [];
  const processor = createCampaignTriggerProcessor({
    ...defaultWhatsappTestDependencies,
    logger: {},
    campaigns: fakeCampaignsRepository,
    campaignVideoCaptionsRepository: noCaptionsRepository,
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

async function testProcessorPrefersGeneratedCaptionOverManualText() {
  const dispatchJobs = [];
  const processor = createCampaignTriggerProcessor({
    ...defaultWhatsappTestDependencies,
    logger: {},
    campaigns: fakeCampaignsRepository,
    campaignVideoCaptionsRepository: {
      listByCampaign: async (campaignId) => {
        assert.equal(campaignId, "campaign-1");

        return [
          {
            group_id: "group-1",
            video_id: "video-1",
            status: "gerado",
            caption_id: "caption-1",
            caption_text: "Legenda gerada pelo agente",
          },
        ];
      },
    },
    dispatchLogs: null,
    campaignGroups: {
      listGroups: async () => [
        { groups: createGroup({ id: "group-1", evolution_group_id: "enabled@g.us", envia_video: true }) },
      ],
    },
    videoFlowRepository: {
      findNextApprovedUnsentVideoForGroup: async () => createVideo({ id: "video-1", drive_file_id: "drive-1" }),
    },
    addDispatchJob: async (payload) => {
      dispatchJobs.push(payload);

      return { id: `dispatch-${dispatchJobs.length}`, data: payload };
    },
  });

  await processor(createJob());

  assert.equal(dispatchJobs.length, 1);
  assert.equal(dispatchJobs[0].legenda, "Legenda gerada pelo agente");
  assert.equal(dispatchJobs[0].caption_id, "caption-1");
}

async function testProcessorUsesJitteredDispatchWhenWindowAndJitterArePresent() {
  const jitterCalls = [];
  const campaignUpdates = [];
  const processor = createCampaignTriggerProcessor({
    ...defaultWhatsappTestDependencies,
    logger: {},
    campaigns: {
      findById: fakeCampaignsRepository.findById,
      update: async (id, payload) => {
        campaignUpdates.push({ id, payload });
        return { id, ...payload };
      },
    },
    campaignVideoCaptionsRepository: noCaptionsRepository,
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
    ...defaultWhatsappTestDependencies,
    logger: {},
    campaigns: {
      findById: async () => ({ id: "campaign-1", nome: "Trilha Campanha" }),
    },
    campaignVideoCaptionsRepository: noCaptionsRepository,
    dispatchLogs: null,
    trilhasRepository: {
      // Nenhuma trilha cadastrada com esse nome: fallback cai no comportamento legado
      // (trilha_override em texto), mantendo o teste original sem tocar rede/banco real.
      findByTrilhaName: async () => null,
    },
    campaignGroups: {
      listGroups: async () => [
        {
          groups: createGroup({
            id: "group-1",
            evolution_group_id: "group-1@g.us",
            segmento: "Outro",
            trilha_id: undefined,
          }),
        },
      ],
    },
    videoFlowRepository: {
      findNextApprovedUnsentVideoForGroup: async (group) => {
        assert.equal(group.trilha_override, "Trilha Campanha");

        return createVideo();
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

async function testProcessorResolvesTrilhaIdFromCampaignNameFallback() {
  const dispatchJobs = [];
  const processor = createCampaignTriggerProcessor({
    ...defaultWhatsappTestDependencies,
    logger: {},
    campaigns: {
      findById: async () => ({ id: "campaign-1", nome: "Trilha Campanha" }),
    },
    campaignVideoCaptionsRepository: noCaptionsRepository,
    dispatchLogs: null,
    trilhasRepository: {
      findByTrilhaName: async (nome) => {
        assert.equal(nome, "Trilha Campanha");

        return { id: "trilha-1", trilha: "Trilha Campanha" };
      },
    },
    campaignGroups: {
      listGroups: async () => [
        {
          groups: createGroup({
            id: "group-1",
            evolution_group_id: "group-1@g.us",
            segmento: "Outro",
            trilha_id: undefined,
          }),
        },
      ],
    },
    videoFlowRepository: {
      findNextApprovedUnsentVideoForGroup: async (group) => {
        assert.equal(group.trilha_id, "trilha-1");
        assert.equal(group.trilha_override, undefined);

        return createVideo();
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
    ...defaultWhatsappTestDependencies,
    logger: {},
    campaigns: fakeCampaignsRepository,
    campaignVideoCaptionsRepository: noCaptionsRepository,
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

  const job = createJob();
  const result = await processor(job);

  assert.equal(result.pending_logs_created, 1);
  assert.deepEqual(createdLogs, [
    {
      id: "log-1",
      campaign_id: "campaign-1",
      group_id: "group-1",
      video_id: "video-1",
      status: "pendente",
      mensagem_erro: null,
      // Derivado do job (e nao uma data fixa): o horario planejado do log vem
      // do execution_at, que agora e relativo ao "agora" do teste.
      horario_envio_planejado: job.updates[0].execution_at,
    },
  ]);
}

async function testProcessorRepairsMissingPlannedTimeOnExistingLog() {
  const existingLog = {
    id: "log-1",
    campaign_id: "campaign-1",
    group_id: "group-1",
    video_id: "video-1",
    horario_envio_planejado: null,
  };
  const repaired = [];

  const created = await ensurePendingDispatchLogs(
    {
      listByCampaign: async () => [existingLog],
      createLog: async () => {
        throw new Error("nao deve criar log duplicado");
      },
      updatePlannedSchedule: async (id, scheduledAt) => {
        repaired.push({ id, scheduledAt });
        return { ...existingLog, horario_envio_planejado: scheduledAt };
      },
    },
    "campaign-1",
    [
      {
        data: {
          campaign_id: "campaign-1",
          progress_group_id: "group-1",
          video_id: "video-1",
          scheduled_at: "2026-07-17T10:05:00.000Z",
        },
      },
    ],
    {}
  );

  assert.equal(created, 0);
  assert.deepEqual(repaired, [{ id: "log-1", scheduledAt: "2026-07-17T10:05:00.000Z" }]);
}

async function testProcessorNotifiesCampaignStartedWhenDispatchesEnqueued() {
  const notifyCalls = [];
  const processor = createCampaignTriggerProcessor({
    ...defaultWhatsappTestDependencies,
    logger: {},
    campaigns: { findById: async (id) => ({ id, trilha: "Pre infancia" }) },
    campaignVideoCaptionsRepository: noCaptionsRepository,
    dispatchLogs: null,
    campaignGroups: {
      listGroups: async () => [
        { groups: createGroup({ id: "group-1", evolution_group_id: "enabled@g.us" }) },
      ],
    },
    videoFlowRepository: {
      findNextApprovedUnsentVideoForGroup: async () => createVideo({ id: "video-1", drive_file_id: "drive-1" }),
    },
    addDispatchJob: async (payload) => ({ id: "dispatch-1", data: payload }),
    notificationsService: {
      notifyCampaignStarted: async (payload) => {
        notifyCalls.push(payload);
        return { sent: true };
      },
    },
  });

  await processor(createJob());

  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0].campaignId, "campaign-1");
  assert.equal(notifyCalls[0].campaignLabel, "Pre infancia");
  assert.equal(notifyCalls[0].groupsCount, 1);
}

async function testProcessorSkipsNotificationWhenNoDispatchesEnqueued() {
  let notifyCalled = false;
  const processor = createCampaignTriggerProcessor({
    ...defaultWhatsappTestDependencies,
    logger: {},
    campaigns: fakeCampaignsRepository,
    campaignVideoCaptionsRepository: noCaptionsRepository,
    dispatchLogs: null,
    campaignGroups: {
      listGroups: async () => [
        { groups: createGroup({ id: "group-1", evolution_group_id: "disabled@g.us", envia_video: false }) },
      ],
    },
    videoFlowRepository: {
      findNextApprovedUnsentVideoForGroup: async () => createVideo(),
    },
    addDispatchJob: async (payload) => ({ id: "dispatch-1", data: payload }),
    notificationsService: {
      notifyCampaignStarted: async () => {
        notifyCalled = true;
        return { sent: true };
      },
    },
  });

  await processor(createJob());

  assert.equal(notifyCalled, false);
}

async function testProcessorSurvivesNotificationFailure() {
  const processor = createCampaignTriggerProcessor({
    ...defaultWhatsappTestDependencies,
    logger: {},
    campaigns: fakeCampaignsRepository,
    campaignVideoCaptionsRepository: noCaptionsRepository,
    dispatchLogs: null,
    campaignGroups: {
      listGroups: async () => [
        { groups: createGroup({ id: "group-1", evolution_group_id: "enabled@g.us" }) },
      ],
    },
    videoFlowRepository: {
      findNextApprovedUnsentVideoForGroup: async () => createVideo({ id: "video-1", drive_file_id: "drive-1" }),
    },
    addDispatchJob: async (payload) => ({ id: "dispatch-1", data: payload }),
    notificationsService: {
      notifyCampaignStarted: async () => {
        throw new Error("Evolution indisponivel");
      },
    },
  });

  const result = await processor(createJob());

  assert.equal(result.status, "processed");
}

// Envio automatizado com TODOS os numeros pausados: nao enfileira nada. Sem esta
// trava os jobs seriam criados e cairiam no sender fixo do .env, furando a pausa.
async function testDoesNotEnqueueWhenAllInstancesArePaused() {
  const addedJobs = [];
  const warnings = [];

  const jobs = await enqueueResolvedDispatchJobs(
    { campaign_id: "campaign-1" },
    [{ progress_group_id: "group-1", evolution_group_id: "evo-1" }],
    {
      whatsappInstancesRepository: {
        listDispatchable: async () => [],
        listActive: async () => [{ id: "instance-1", paused_at: "2026-08-31T10:00:00.000Z" }],
      },
      whatsappInstancesService: {
        getRotationSettings: async () => ({ whatsapp_rotation_group_count: 1 }),
      },
      addDispatchJob: async (payload) => {
        addedJobs.push(payload);
        return { id: "job-1" };
      },
      addJitteredDispatchJobs: async (payloads) => {
        addedJobs.push(...payloads);
        return [];
      },
      logger: { warn: (line) => warnings.push(line) },
    }
  );

  assert.deepEqual(jobs, [], "nenhum job deve ser enfileirado");
  assert.equal(addedJobs.length, 0, "nao pode chamar addDispatchJob com tudo pausado");
  assert.ok(
    warnings.some((line) => line.includes("dispatch.skipped_all_instances_paused")),
    "deve registrar o motivo do skip para nao virar sumico silencioso"
  );
}

// Contraste: nenhuma instancia cadastrada (instalacao legada) segue enfileirando
// normalmente - so "tudo pausado" bloqueia.
async function testStillEnqueuesWhenNoInstancesAreRegistered() {
  const addedJobs = [];

  const jobs = await enqueueResolvedDispatchJobs(
    { campaign_id: "campaign-1" },
    [{ progress_group_id: "group-1", evolution_group_id: "evo-1" }],
    {
      whatsappInstancesRepository: {
        listDispatchable: async () => [],
        listActive: async () => [],
      },
      whatsappInstancesService: {
        getRotationSettings: async () => ({ whatsapp_rotation_group_count: 1 }),
      },
      addDispatchJob: async (payload) => {
        addedJobs.push(payload);
        return { id: "job-1" };
      },
      addJitteredDispatchJobs: async (payloads) => {
        addedJobs.push(...payloads);
        return payloads.map((_, index) => ({ id: `job-${index}` }));
      },
    }
  );

  assert.ok(jobs.length > 0 || addedJobs.length > 0, "instalacao legada deve continuar enfileirando");
}

async function main() {
  await testVideoFlowRepositoryUsesGroupProgress();
  await testProcessorFiltersVideoEnabledGroupsAndEnqueuesDispatch();
  await testProcessorPrefersGeneratedCaptionOverManualText();
  await testProcessorUsesJitteredDispatchWhenWindowAndJitterArePresent();
  await testProcessorUsesCampaignNameAsTrailFallback();
  await testProcessorResolvesTrilhaIdFromCampaignNameFallback();
  await testProcessorCreatesPendingDispatchLogAfterEnqueue();
  await testProcessorRepairsMissingPlannedTimeOnExistingLog();
  await testProcessorNotifiesCampaignStartedWhenDispatchesEnqueued();
  await testProcessorSkipsNotificationWhenNoDispatchesEnqueued();
  await testProcessorSurvivesNotificationFailure();
  await testDoesNotEnqueueWhenAllInstancesArePaused();
  await testStillEnqueuesWhenNoInstancesAreRegistered();

  console.log("campaign-trigger-processor tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await closeQueueInfrastructure();
});
