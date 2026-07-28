const assert = require("node:assert/strict");

const organizationsService = require("../src/services/organizations.service");
const groupsService = require("../src/services/groups.service");
const campaignsService = require("../src/services/campaigns.service");
const videoCatalogService = require("../src/services/video-catalog.service");
const groupVideoProgressService = require("../src/services/group-video-progress.service");
const dispatchLogsService = require("../src/services/dispatch-logs.service");
const campaignVideoCaptionsService = require("../src/services/campaign-video-captions.service");

async function main() {
  const orgRepository = {
    create: async (payload) => ({ id: "org-1", ...payload }),
    delete: async () => ({ id: "org-1" }),
    findAll: async () => [],
    findById: async (id) => (id === "org-1" ? { id, nome: "Acme" } : null),
    update: async (id, payload) => ({ id, ...payload }),
  };

  const persistedGroups = [
    { id: "group-existing", nome: "Antigo", evolution_group_id: "120363existing@g.us", quantidade_membros: 2 },
  ];
  const groupRepository = {
    create: async (payload) => {
      const created = { id: `group-${persistedGroups.length + 1}`, ...payload };
      persistedGroups.push(created);
      return created;
    },
    delete: async () => ({ id: "group-1" }),
    findAll: async () => [],
    findByEvolutionGroupId: async (evolutionGroupId) =>
      persistedGroups.find((group) => group.evolution_group_id === evolutionGroupId) || null,
    findById: async (id) => {
      if (id === "group-1") {
        return { id, nome: "Grupo", evolution_group_id: "evo-1", organization_id: "org-1" };
      }

      if (id === "group-with-progress") {
        return {
          id,
          nome: "Grupo com progresso",
          evolution_group_id: "evo-progress",
          trilha_id: "trilha-1",
          organization_id: "org-1",
        };
      }

      return persistedGroups.find((group) => group.id === id) || null;
    },
    listByOrganization: async () => [{ id: "group-1" }],
    listVideoEnabled: async () => [{ id: "group-1", envia_video: true }],
    listWithoutSegment: async () => persistedGroups.filter((group) => group.segmento === null),
    update: async (id, payload) => {
      const index = persistedGroups.findIndex((group) => group.id === id);
      const updated = { ...persistedGroups[index], ...payload };
      persistedGroups[index] = updated;
      return updated;
    },
  };

  const persistedCampaignsByDate = new Map();
  const campaignRepository = {
    create: async (payload) => {
      const campaign = { id: "campaign-1", status: "programado", ...payload };
      if (payload.data_envio) {
        persistedCampaignsByDate.set(payload.data_envio, campaign);
      }
      return campaign;
    },
    delete: async () => ({ id: "campaign-1" }),
    findAll: async () => [{ id: "campaign-1", trilha: "Campanha", ativo: true }],
    findByData: async (dataEnvio) => persistedCampaignsByDate.get(dataEnvio) || null,
    findById: async (id) => (id === "campaign-1" ? { id, nome: "Campanha", ativo: true } : null),
    listActive: async () => [{ id: "campaign-1", ativo: true }],
    update: async (id, payload) => ({ id, ...payload }),
  };

  const videoCatalogRepository = {
    create: async (payload) => ({ id: "video-1", ...payload }),
    delete: async () => ({ id: "video-1" }),
    findAll: async () => [],
    findById: async (id) => (id === "video-1" ? { id, drive_file_id: "drive-1", status: true } : null),
    findByDriveFileId: async (driveFileId) => (driveFileId === "drive-1" ? { id: "video-1" } : null),
    listApproved: async () => [
      { id: "video-a1", ordem_geral: 1, nome_do_arquivo: "a1.mp4", status: true },
      { id: "video-a2", ordem_geral: 2, nome_do_arquivo: "a2.mp4", status: true },
    ],
    listByStatus: async () => [{ id: "video-1" }],
    update: async (id, payload) => ({ id, ...payload }),
  };

  const progressRepository = {
    getLastVideo: async () => ({ id: "progress-1" }),
    hasDuplicate: async () => true,
    listDelivered: async () => [{ id: "progress-1" }],
    listDeliveredWithVideo: async (groupId) =>
      groupId === "group-with-progress"
        ? [
            {
              group_id: groupId,
              video_id: "video-a1",
              enviado_em: "2026-07-17T10:00:00.000Z",
              trilha_id: "trilha-1",
              video_catalog: { id: "video-a1", perfil_da_jornada: "Pre infancia", nome_do_arquivo: "a1.mp4" },
            },
          ]
        : [],
    registerDelivery: async (payload) => ({ id: "progress-1", ...payload }),
  };

  const dispatchLogRepository = {
    createLog: async (payload) => ({ id: "log-1", ...payload }),
    listByCampaign: async (campaignId) =>
      campaignId === "campaign-1"
        ? [
            {
              id: "log-1",
              campaign_id: "campaign-1",
              group_id: "group-1",
              video_id: "video-1",
              status: "enviado",
              criado_em: "2026-07-17T10:05:00.000Z",
            },
          ]
        : [],
    listByGroup: async () => [{ id: "log-1" }],
    listRecent: async () => [{ id: "log-1" }],
    listWithFilters: async (filters) => [
      {
        id: "log-1",
        campaign_id: "campaign-1",
        group_id: "group-1",
        video_id: "video-1",
        status: filters.status || "enviado",
        criado_em: "2026-07-17T10:05:00.000Z",
        campaigns: { id: "campaign-1", trilha: "Trilha A", data_envio: "2026-07-17" },
        groups: { id: "group-1", nome: "Grupo", organization_id: "org-1", organizations: { id: "org-1", nome: "Acme" } },
        video_catalog: { id: "video-1", nome_do_arquivo: "video.mp4" },
      },
      {
        id: "log-2",
        campaign_id: "campaign-2",
        group_id: "group-2",
        video_id: "video-2",
        status: "erro",
        criado_em: "2026-07-18T10:05:00.000Z",
        campaigns: { id: "campaign-2", trilha: "Trilha B", data_envio: "2026-07-18" },
        groups: { id: "group-2", nome: "Grupo 2", organization_id: "org-2", organizations: { id: "org-2", nome: "Beta" } },
        video_catalog: { id: "video-2", nome_do_arquivo: "video2.mp4" },
      },
    ],
    updateStatus: async (id, status) => ({ id, status }),
  };
  const associatedCampaignGroups = [];
  const campaignTriggerJobs = [];
  const campaignGroupsRepository = {
    associateGroup: async (campaignId, groupId, organizationId) => {
      const record = {
        campaign_id: campaignId,
        group_id: groupId,
        organization_id: organizationId,
        created_at: "2026-07-17T10:00:00.000Z",
      };
      associatedCampaignGroups.push(record);
      return record;
    },
    listGroups: async (campaignId) => {
      const groupsById = {
        "group-1": { id: "group-1", nome: "Grupo", evolution_group_id: "evo-1", envia_video: true, trilha_override: "Trilha A" },
        "group-with-progress": { id: "group-with-progress", nome: "Grupo com progresso", evolution_group_id: "evo-progress", trilha_override: "Trilha A" },
      };

      return associatedCampaignGroups
        .filter((row) => row.campaign_id === campaignId)
        .map((row) => ({ ...row, groups: groupsById[row.group_id] || { id: row.group_id } }));
    },
  };

  const campaignVideoCaptionRows = [];
  const campaignVideoCaptionsRepository = {
    createPending: async (payload) => {
      const row = { id: `cvc-${campaignVideoCaptionRows.length + 1}`, status: "processando", ...payload };
      campaignVideoCaptionRows.push(row);
      return row;
    },
    listByCampaign: async (campaignId) => campaignVideoCaptionRows.filter((row) => row.campaign_id === campaignId),
    markError: async (id, payload) => {
      const row = campaignVideoCaptionRows.find((item) => item.id === id);
      Object.assign(row, { status: "erro", ...payload });
      return row;
    },
    markGenerated: async (id, payload) => {
      const row = campaignVideoCaptionRows.find((item) => item.id === id);
      Object.assign(row, { status: "gerado", ...payload });
      return row;
    },
    updateCaptionText: async (id, payload) => {
      const row = campaignVideoCaptionRows.find((item) => item.id === id);
      Object.assign(row, { status: "gerado", ...payload });
      return row;
    },
  };
  const videoCaptionsServiceStub = {
    selectCaptionForVideo: async (videoId, options = {}) => {
      const excluded = new Set(options.excludeCaptionIds || []);
      if (videoId === "video-caption-fail") {
        throw new Error("Falha ao gerar legenda via IA");
      }
      const candidateId = excluded.has(`caption-${videoId}`) ? `caption-${videoId}-alt` : `caption-${videoId}`;
      return { caption: { id: candidateId }, generated: true, text: `Legenda para ${videoId}` };
    },
  };
  const captionReviewServiceStub = {
    assertCaptionApproved: async () => ({ approved: true, reason: "ok" }),
  };
  const campaignVideoCaptionsServiceInstance = campaignVideoCaptionsService.createCampaignVideoCaptionsService({
    campaignGroups: campaignGroupsRepository,
    campaigns: campaignRepository,
    captionReviewService: captionReviewServiceStub,
    groupVideoProgressRepository: progressRepository,
    repository: campaignVideoCaptionsRepository,
    videoCaptionsService: videoCaptionsServiceStub,
    videoCatalogRepository,
    videoFlowRepository: {
      findNextApprovedUnsentVideoForGroup: async (group) => {
        if (group.id === "group-1") {
          return { id: "video-flow-1", drive_file_id: "drive-flow-1", trilha: group.trilha_override };
        }
        return undefined;
      },
    },
  });

  const trilhasFakeRepository = {
    findById: async (id) => (id === "trilha-1" ? { id, macrotema: "Macrotema A", trilha: "Trilha A" } : null),
    findFirstApprovedVideoByTrilhaAndProfile: async (trilhaId, perfil) => {
      if (trilhaId === "trilha-1" && perfil === "Pre infancia") {
        return { id: "video-trilha-1", drive_file_id: "drive-trilha-1", nome_do_arquivo: "aula-trilha.mp4" };
      }
      return null;
    },
    listVideoLinksByTrilha: async (trilhaId) =>
      trilhaId === "trilha-1"
        ? [
            { trilha_id: "trilha-1", video_id: "video-a1", ordem: 1 },
            { trilha_id: "trilha-1", video_id: "video-a2", ordem: 2 },
          ]
        : [],
  };

  const orgService = organizationsService.createOrganizationsService({ repository: orgRepository });
  const groupService = groupsService.createGroupsService({
    trilhasRepository: trilhasFakeRepository,
    addDispatchJob: async (payload) => ({ id: "dispatch-test-1", name: "dispatch-content", queueName: "dispatch", data: payload }),
    fetchEvolutionGroups: async () => ({
      data: [
        {
          id: "120363new@g.us",
          subject: "Grupo Novo",
          participants: [{ id: "1" }, { id: "2" }, { id: "3" }],
        },
        {
          id: "120363existing@g.us",
          subject: "Grupo Existente",
          participantsCount: 4,
        },
        {
          id: "120363new@g.us",
          subject: "Grupo Novo duplicado",
        },
        {
          id: "",
          subject: "Sem id",
        },
      ],
    }),
    organizationRepository: orgRepository,
    repository: groupRepository,
  });
  const campaignService = campaignsService.createCampaignsService({
    addCampaignTriggerJob: async (payload) => {
      const job = {
        id: `trigger-${campaignTriggerJobs.length + 1}`,
        name: "trigger-campaign",
        queueName: "campaign-trigger",
        data: payload,
      };
      campaignTriggerJobs.push(job);
      return job;
    },
    campaignGroupsRepository,
    campaignVideoCaptionsService: campaignVideoCaptionsServiceInstance,
    dispatchLogsRepository: dispatchLogRepository,
    groupsRepository: groupRepository,
    groupVideoProgressRepository: progressRepository,
    organizationRepository: orgRepository,
    repository: campaignRepository,
    videoCatalogRepository,
  });
  const videoService = videoCatalogService.createVideoCatalogService({ repository: videoCatalogRepository });
  const progressService = groupVideoProgressService.createGroupVideoProgressService({
    groupsRepository: groupRepository,
    repository: progressRepository,
    trilhasRepository: trilhasFakeRepository,
    videoCatalogRepository,
  });
  const dispatchService = dispatchLogsService.createDispatchLogsService({
    campaignsRepository: campaignRepository,
    groupsRepository: groupRepository,
    repository: dispatchLogRepository,
    videoCatalogRepository,
  });

  const createdOrg = await orgService.create({ nome: "Acme" });
  assert.ok(createdOrg.id);

  await assert.rejects(() => orgService.create({ nome: "   " }), /required/);
  await assert.rejects(() => orgService.update("", { nome: "Novo" }), /required/);
  await assert.rejects(() => orgService.getById(""), /required/);

  const createdGroup = await groupService.create({ nome: "Grupo", organization_id: "org-1", evolution_group_id: "evo-1", maturidade: 2 });
  assert.ok(createdGroup.id);
  await assert.rejects(() => groupService.create({ nome: "Grupo", organization_id: "org-1" }), /required/);
  await assert.rejects(() => groupService.listByOrganization(""), /required/);
  const syncedGroups = await groupService.syncGroupsFromEvolution({ maturidade: 2 });
  assert.equal(syncedGroups.inserted, 1);
  assert.equal(syncedGroups.updated, 1);
  assert.equal(syncedGroups.ignored, 2);
  const insertedGroup = persistedGroups.find((group) => group.evolution_group_id === "120363new@g.us");
  assert.equal(insertedGroup.segmento, null);
  assert.equal(insertedGroup.organization_id, null);
  assert.equal(insertedGroup.envia_video, false);
  assert.deepEqual(syncedGroups.groups, [
    { id: "120363new@g.us", nome: "Grupo Novo", quantidade_membros: 3 },
    { id: "120363existing@g.us", nome: "Grupo Existente", quantidade_membros: 4 },
  ]);
  const groupsWithoutSegment = await groupService.listWithoutSegment();
  assert.equal(groupsWithoutSegment.length, 1);
  assert.equal(groupsWithoutSegment[0].evolution_group_id, "120363new@g.us");
  const updatedOperationalSettings = await groupService.updateOperationalSettings(insertedGroup.id, {
    organization_id: "org-1",
    segmento: "Pre infancia",
    envia_video: true,
    trilha_override: "Trilha A",
    nome: "Nome vindo da Evolution nao deve mudar",
    evolution_group_id: "outro@g.us",
  });
  assert.equal(updatedOperationalSettings.segmento, "Pre infancia");
  assert.equal(updatedOperationalSettings.organization_id, "org-1");
  assert.equal(updatedOperationalSettings.envia_video, true);
  assert.equal(updatedOperationalSettings.trilha_override, "Trilha A");
  assert.equal(updatedOperationalSettings.nome, "Grupo Novo");
  assert.equal(updatedOperationalSettings.evolution_group_id, "120363new@g.us");
  await assert.rejects(
    () => groupService.updateOperationalSettings(insertedGroup.id, { envia_video: "true" }),
    /boolean/,
  );

  const updatedWithTrilhaId = await groupService.updateOperationalSettings(insertedGroup.id, {
    trilha_id: "trilha-1",
  });
  assert.equal(updatedWithTrilhaId.trilha_id, "trilha-1");
  await assert.rejects(
    () => groupService.updateOperationalSettings(insertedGroup.id, { trilha_id: "trilha-inexistente" }),
    /Trilha not found/,
  );

  const dispatchByTrilhaId = await groupService.dispatchTestVideo(insertedGroup.id, {
    trilha_id: "trilha-1",
    segmento: "Pre infancia",
    envia_video: true,
  });
  assert.equal(dispatchByTrilhaId.video.id, "video-trilha-1");
  assert.equal(dispatchByTrilhaId.group.trilha_id, "trilha-1");

  const createdCampaign = await campaignService.create({
    nome: "Campanha",
    execution_at: "2026-07-17T09:30:00.000Z",
  });
  assert.ok(createdCampaign.id);
  assert.equal(createdCampaign.trilha, "Campanha");
  assert.equal(createdCampaign.data_envio, null);
  assert.equal(createdCampaign.horario_envio, null);
  await assert.rejects(() => campaignService.create({}), /required/);
  const queuedCampaign = await campaignService.createAndQueue({
    group_ids: ["group-1"],
    execution_at: "2026-07-17T10:00:00.000Z",
  });
  assert.equal(queuedCampaign.campaign.ativo, true);
  assert.match(queuedCampaign.campaign.trilha, /Campanha do dia 17\/07/);
  assert.equal(queuedCampaign.campaign.data_envio, "2026-07-17");
  assert.equal(associatedCampaignGroups[0].group_id, "group-1");
  assert.equal(campaignTriggerJobs[0].data.execution_at, "2026-07-17T10:00:00.000Z");
  assert.equal(campaignTriggerJobs[0].data.window_start, "2026-07-17T10:00:00.000Z");
  assert.equal(campaignTriggerJobs[0].data.window_end, "2026-07-17T11:00:00.000Z");
  assert.equal(campaignTriggerJobs[0].data.jitter_delay_min_ms, 60000);

  const queuedCampaignSecondGroup = await campaignService.createAndQueue({
    group_ids: ["group-with-progress"],
    execution_at: "2026-07-17T11:00:00.000Z",
    defer_dispatch: true,
  });
  assert.equal(queuedCampaignSecondGroup.campaign.id, queuedCampaign.campaign.id);
  assert.equal(queuedCampaignSecondGroup.trigger_job, null);
  assert.equal(associatedCampaignGroups.length, 2);
  assert.equal(associatedCampaignGroups[1].group_id, "group-with-progress");

  const campaignsSummary = await campaignService.listWithSummary();
  assert.equal(campaignsSummary[0].grupos_total, 2);
  assert.equal(campaignsSummary[0].status, "programado");

  const groupsDetail = await campaignService.getGroupsDetail("campaign-1");
  assert.equal(groupsDetail.length, 2);
  assert.equal(groupsDetail[0].group_id, "group-1");
  assert.equal(groupsDetail[0].nome, "Grupo");
  assert.equal(groupsDetail[0].status, "enviado");
  assert.equal(groupsDetail[0].video_id, "video-1");
  assert.equal(groupsDetail[1].group_id, "group-with-progress");
  assert.equal(groupsDetail[1].status, "pendente");
  await assert.rejects(() => campaignService.getGroupsDetail("campaign-missing"), /not found/);

  const todayCampaign = await campaignService.findOrCreateForToday({
    reference_date: "2026-07-21T12:00:00.000Z",
  });
  assert.match(todayCampaign.trilha, /Campanha do dia 21\/07/);
  assert.equal(todayCampaign.data_envio, "2026-07-21");
  const sameDayCampaign = await campaignService.findOrCreateForToday({
    reference_date: "2026-07-21T18:00:00.000Z",
  });
  assert.equal(sameDayCampaign.id, todayCampaign.id);

  const createdVideo = await videoService.create({ drive_file_id: "drive-service-1", etapa: 1, status: true });
  assert.ok(createdVideo.id);
  await assert.rejects(() => videoService.create({ drive_file_id: "", etapa: 1 }), /required/);

  await assert.rejects(() => progressService.recordDelivery({ group_id: "group-1", video_id: "video-1" }), /already registered/);
  const history = await progressService.listDelivered("group-1");
  assert.ok(Array.isArray(history));

  const progressSummary = await progressService.getGroupProgressSummary("group-with-progress");
  assert.equal(progressSummary.current.trilha, "Trilha A");
  assert.equal(progressSummary.current.trilha_id, "trilha-1");
  assert.equal(progressSummary.current.total, 2);
  assert.equal(progressSummary.current.enviados, 1);
  assert.equal(progressSummary.current.concluida, false);
  assert.equal(progressSummary.current.next_video.id, "video-a2");
  assert.equal(progressSummary.history.length, 1);
  assert.equal(progressSummary.history[0].trilha, "Trilha A");
  assert.equal(progressSummary.history[0].trilha_id, "trilha-1");
  assert.equal(progressSummary.history[0].enviados, 1);
  await assert.rejects(() => progressService.getGroupProgressSummary(""), /required/);
  await assert.rejects(() => progressService.getGroupProgressSummary("group-missing"), /not found/);

  const dispatchLog = await dispatchService.createLog({ campaign_id: "campaign-1", group_id: "group-1", video_id: "video-1", status: "pendente" });
  assert.ok(dispatchLog.id);
  await assert.rejects(() => dispatchService.createLog({ campaign_id: "", group_id: "group-1", video_id: "video-1" }), /required/);

  const reportRows = await dispatchService.listForReport({ startDate: "2026-07-01", endDate: "2026-07-20" });
  assert.equal(reportRows.length, 2);
  assert.equal(reportRows[0].groups.organizations.nome, "Acme");

  const reportRowsByOrg = await dispatchService.listForReport({ organizationId: "org-2" });
  assert.equal(reportRowsByOrg.length, 1);
  assert.equal(reportRowsByOrg[0].groups.organizations.nome, "Beta");

  const farFuture = "2026-12-31";
  await assert.rejects(() => dispatchService.listForReport({ startDate: farFuture }), /future/);
  await assert.rejects(() => dispatchService.listForReport({ endDate: farFuture }), /future/);
  await assert.rejects(
    () => dispatchService.listForReport({ startDate: "2026-07-20", endDate: "2026-07-01" }),
    /after end date/
  );

  const captionGeneration = await campaignVideoCaptionsServiceInstance.generateCaptionsForCampaign("campaign-1");
  assert.equal(captionGeneration.generated.length, 1);
  assert.equal(captionGeneration.generated[0].status, "gerado");
  assert.equal(captionGeneration.generated[0].caption_text, "Legenda para video-flow-1");
  assert.equal(captionGeneration.progress.total, 1);
  assert.equal(captionGeneration.progress.pendente, 0);

  const captionProgress = await campaignVideoCaptionsServiceInstance.getCaptionProgress("campaign-1");
  assert.equal(captionProgress.gerado, 1);
  await assert.rejects(() => campaignVideoCaptionsServiceInstance.getCaptionProgress(""), /required/);

  const editedCaption = await campaignVideoCaptionsServiceInstance.updateCaptionText(
    captionGeneration.generated[0].id,
    "Legenda revisada manualmente"
  );
  assert.equal(editedCaption.caption_text, "Legenda revisada manualmente");
  await assert.rejects(() => campaignVideoCaptionsServiceInstance.updateCaptionText("cvc-1", "  "), /required/);

  const dispatchedCampaign = await campaignService.dispatchCampaign({
    group_ids: ["group-1"],
    execution_at: "2026-07-18T10:00:00.000Z",
  });
  assert.equal(dispatchedCampaign.trigger_job, null);
  await new Promise((resolve) => setImmediate(resolve));
  const progressAfterDispatch = await campaignVideoCaptionsServiceInstance.getCaptionProgress(
    dispatchedCampaign.campaign.id
  );
  assert.equal(progressAfterDispatch.pendente, 0);
  assert.ok(progressAfterDispatch.total >= 1);

  const confirmedDispatch = await campaignService.confirmDispatch(dispatchedCampaign.campaign.id, {
    execution_at: "2026-07-18T10:00:00.000Z",
  });
  assert.equal(confirmedDispatch.campaign.status, "programado");
  assert.ok(confirmedDispatch.trigger_job.id);

  await assert.rejects(
    () =>
      campaignService.confirmDispatch("campaign-missing", {
        execution_at: "2026-07-18T10:00:00.000Z",
      }),
    /not found/
  );

  console.log("services tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
