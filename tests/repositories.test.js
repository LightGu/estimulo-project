const assert = require("node:assert/strict");

const organizationsRepository = require("../src/repositories/organizations.repository");
const groupsRepository = require("../src/repositories/groups.repository");
const campaignsRepository = require("../src/repositories/campaigns.repository");
const campaignGroupsRepository = require("../src/repositories/campaign-groups.repository");
const videoCatalogRepository = require("../src/repositories/video-catalog.repository");
const videoCaptionsRepository = require("../src/repositories/video-captions.repository");
const groupVideoProgressRepository = require("../src/repositories/group-video-progress.repository");
const dispatchLogsRepository = require("../src/repositories/dispatch-logs.repository");

function createMockClient() {
  const calls = [];
  const createBuilder = (result) => ({
    select() {
      return this;
    },
    insert(payload) {
      calls.push({ type: "insert", payload });
      return this;
    },
    update(payload) {
      calls.push({ type: "update", payload });
      return this;
    },
    delete() {
      calls.push({ type: "delete" });
      return this;
    },
    eq(column, value) {
      calls.push({ type: "eq", column, value });
      return this;
    },
    is(column, value) {
      calls.push({ type: "is", column, value });
      return this;
    },
    or(condition) {
      calls.push({ type: "or", condition });
      return this;
    },
    order() {
      return this;
    },
    limit() {
      return Promise.resolve({ data: result, error: null });
    },
    maybeSingle() {
      return Promise.resolve({ data: result, error: null });
    },
    single() {
      return Promise.resolve({ data: result, error: null });
    },
  });

  const client = {
    from(tableName) {
      calls.push({ type: "from", tableName });
      return createBuilder({
        id: "record-1",
        nome: "Registro",
        status: true,
        group_id: "group-1",
        campaign_id: "campaign-1",
        video_id: "video-1",
        organization_id: "org-1",
        ativo: true,
        envia_video: true,
      });
    },
    __calls: calls,
  };

  return client;
}

async function main() {
  const client = createMockClient();

  try {
    const org = await organizationsRepository.create({ nome: "Acme" }, client);
    assert.ok(org);

    const updatedOrg = await organizationsRepository.update("org-1", { nome: "Acme 2" }, client);
    assert.ok(updatedOrg);

    const foundOrg = await organizationsRepository.findById("org-1", client);
    assert.ok(foundOrg);

    const allOrgs = await organizationsRepository.findAll(client);
    assert.ok(Array.isArray(allOrgs));

    const removedOrg = await organizationsRepository.delete("org-1", client);
    assert.ok(removedOrg);

    const group = await groupsRepository.create({ nome: "Grupo 1", organization_id: "org-1", envia_video: true }, client);
    assert.ok(group);
    await groupsRepository.update("group-1", { nome: "Grupo 2" }, client);
    await groupsRepository.findById("group-1", client);
    await groupsRepository.findByEvolutionGroupId("evo-1", client);
    await groupsRepository.listByOrganization("org-1", client);
    await groupsRepository.listVideoEnabled(client);
    await groupsRepository.listWithoutSegment(client);
    assert.ok(client.__calls.some((call) => call.type === "is" && call.column === "segmento" && call.value === null));
    await groupsRepository.delete("group-1", client);

    await campaignsRepository.create({ nome: "Campanha", organization_id: "org-1", ativo: true }, client);
    await campaignsRepository.update("camp-1", { ativo: false }, client);
    await campaignsRepository.findById("camp-1", client);
    await campaignsRepository.findAll(client);
    await campaignsRepository.listActive(client);
    await campaignsRepository.listByOrganization("org-1", client);
    await campaignsRepository.delete("camp-1", client);

    await campaignGroupsRepository.associateGroup("camp-1", "group-1", client);
    await campaignGroupsRepository.listGroups("camp-1", client);
    await campaignGroupsRepository.removeGroup("camp-1", "group-1", client);

    await videoCatalogRepository.create({ drive_file_id: "drive-1", etapa: 1, trilha_segmento: "Pré", status: true }, client);
    await videoCatalogRepository.update("video-1", { status: false }, client);
    await videoCatalogRepository.findById("video-1", client);
    await videoCatalogRepository.findAll(client);
    await videoCatalogRepository.listApproved(client);
    await videoCatalogRepository.listBySegmento("Pré", client);
    await videoCatalogRepository.listByEtapa(1, client);
    await videoCatalogRepository.listByStatus(true, client);
    await videoCatalogRepository.findByDriveFileId("drive-1", client);
    await videoCatalogRepository.delete("video-1", client);

    await videoCaptionsRepository.listUnusedTodayByVideo("video-1", new Date("2026-07-21T03:00:00.000Z"), client);
    await videoCaptionsRepository.markUsed("caption-1", new Date("2026-07-21T15:00:00.000Z"), client);
    assert.ok(client.__calls.some((call) => call.type === "from" && call.tableName === "video_captions"));
    assert.ok(client.__calls.some((call) => call.type === "or" && call.condition.includes("ultimo_uso_em.is.null")));

    await groupVideoProgressRepository.registerDelivery({ group_id: "group-1", video_id: "video-1" }, client);
    await groupVideoProgressRepository.listDelivered("group-1", client);
    await groupVideoProgressRepository.getLastVideo("group-1", client);
    await groupVideoProgressRepository.hasDuplicate("group-1", "video-1", client);

    await dispatchLogsRepository.createLog({ campaign_id: "camp-1", group_id: "group-1", video_id: "video-1", status: "pendente" }, client);
    await dispatchLogsRepository.updateStatus("log-1", "enviado", null, client);
    await dispatchLogsRepository.listByCampaign("camp-1", client);
    await dispatchLogsRepository.listByGroup("group-1", client);
    await dispatchLogsRepository.listRecent(5, client);
  } finally {
    // no-op
  }

  console.log("repositories tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
