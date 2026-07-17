const assert = require("node:assert/strict");

const organizationsService = require("../src/services/organizations.service");
const groupsService = require("../src/services/groups.service");
const campaignsService = require("../src/services/campaigns.service");
const videoCatalogService = require("../src/services/video-catalog.service");
const groupVideoProgressService = require("../src/services/group-video-progress.service");
const dispatchLogsService = require("../src/services/dispatch-logs.service");

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
    findById: async (id) => (id === "group-1" ? { id, nome: "Grupo", evolution_group_id: "evo-1" } : null),
    listByOrganization: async () => [{ id: "group-1" }],
    listVideoEnabled: async () => [{ id: "group-1", envia_video: true }],
    update: async (id, payload) => {
      const index = persistedGroups.findIndex((group) => group.id === id);
      const updated = { ...persistedGroups[index], ...payload };
      persistedGroups[index] = updated;
      return updated;
    },
  };

  const campaignRepository = {
    create: async (payload) => ({ id: "campaign-1", ...payload }),
    delete: async () => ({ id: "campaign-1" }),
    findAll: async () => [],
    findById: async (id) => (id === "campaign-1" ? { id, nome: "Campanha", ativo: true } : null),
    listActive: async () => [{ id: "campaign-1", ativo: true }],
    listByOrganization: async () => [{ id: "campaign-1" }],
    update: async (id, payload) => ({ id, ...payload }),
  };

  const videoCatalogRepository = {
    create: async (payload) => ({ id: "video-1", ...payload }),
    delete: async () => ({ id: "video-1" }),
    findAll: async () => [],
    findById: async (id) => (id === "video-1" ? { id, drive_file_id: "drive-1", status: true } : null),
    findByDriveFileId: async (driveFileId) => (driveFileId === "drive-1" ? { id: "video-1" } : null),
    listApproved: async () => [{ id: "video-1" }],
    listByEtapa: async () => [{ id: "video-1" }],
    listBySegmento: async () => [{ id: "video-1" }],
    listByStatus: async () => [{ id: "video-1" }],
    update: async (id, payload) => ({ id, ...payload }),
  };

  const progressRepository = {
    getLastVideo: async () => ({ id: "progress-1" }),
    hasDuplicate: async () => true,
    listDelivered: async () => [{ id: "progress-1" }],
    registerDelivery: async (payload) => ({ id: "progress-1", ...payload }),
  };

  const dispatchLogRepository = {
    createLog: async (payload) => ({ id: "log-1", ...payload }),
    listByCampaign: async () => [{ id: "log-1" }],
    listByGroup: async () => [{ id: "log-1" }],
    listRecent: async () => [{ id: "log-1" }],
    updateStatus: async (id, status) => ({ id, status }),
  };

  const orgService = organizationsService.createOrganizationsService({ repository: orgRepository });
  const groupService = groupsService.createGroupsService({
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
    organizationRepository: orgRepository,
    repository: campaignRepository,
  });
  const videoService = videoCatalogService.createVideoCatalogService({ repository: videoCatalogRepository });
  const progressService = groupVideoProgressService.createGroupVideoProgressService({
    groupsRepository: groupRepository,
    repository: progressRepository,
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
  const syncedGroups = await groupService.syncGroupsFromEvolution({ organization_id: "org-1", segmento: "geral", maturidade: 2 });
  assert.equal(syncedGroups.inserted, 1);
  assert.equal(syncedGroups.updated, 1);
  assert.equal(syncedGroups.ignored, 2);
  assert.deepEqual(syncedGroups.groups, [
    { id: "120363new@g.us", nome: "Grupo Novo", quantidade_membros: 3 },
    { id: "120363existing@g.us", nome: "Grupo Existente", quantidade_membros: 4 },
  ]);

  const createdCampaign = await campaignService.create({ nome: "Campanha", organization_id: "org-1", cron_expression: "0 * * * *" });
  assert.ok(createdCampaign.id);
  await assert.rejects(() => campaignService.create({ nome: "Campanha", organization_id: "org-1" }), /required/);

  const createdVideo = await videoService.create({ drive_file_id: "drive-service-1", etapa: 1, status: true });
  assert.ok(createdVideo.id);
  await assert.rejects(() => videoService.create({ drive_file_id: "", etapa: 1 }), /required/);
  await assert.rejects(() => videoService.listByEtapa(0), /positive/);

  await assert.rejects(() => progressService.recordDelivery({ group_id: "group-1", video_id: "video-1" }), /already registered/);
  const history = await progressService.listDelivered("group-1");
  assert.ok(Array.isArray(history));

  const dispatchLog = await dispatchService.createLog({ campaign_id: "campaign-1", group_id: "group-1", video_id: "video-1", status: "pendente" });
  assert.ok(dispatchLog.id);
  await assert.rejects(() => dispatchService.createLog({ campaign_id: "", group_id: "group-1", video_id: "video-1" }), /required/);

  console.log("services tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
