const dispatchLogsRepository = require("../repositories/dispatch-logs.repository");
const campaignsRepository = require("../repositories/campaigns.repository");
const groupsRepository = require("../repositories/groups.repository");
const videoCatalogRepository = require("../repositories/video-catalog.repository");

function createDispatchLogsService(dependencies = {}) {
  const repository = dependencies.repository || dispatchLogsRepository;
  const campaignsRepositoryDependency = dependencies.campaignsRepository || campaignsRepository;
  const groupsRepositoryDependency = dependencies.groupsRepository || groupsRepository;
  const videoCatalogRepositoryDependency = dependencies.videoCatalogRepository || videoCatalogRepository;

  async function createLog(payload) {
    const campaignId = payload?.campaign_id;
    const groupId = payload?.group_id;
    const videoId = payload?.video_id;
    const status = payload?.status || "pendente";

    if (!campaignId) {
      throw new Error("Campaign id is required");
    }

    if (!groupId) {
      throw new Error("Group id is required");
    }

    if (!videoId) {
      throw new Error("Video id is required");
    }

    const campaign = await campaignsRepositoryDependency.findById(campaignId);
    const group = await groupsRepositoryDependency.findById(groupId);
    const video = await videoCatalogRepositoryDependency.findById(videoId);

    if (!campaign) {
      throw new Error("Campaign not found");
    }

    if (!group) {
      throw new Error("Group not found");
    }

    if (!video) {
      throw new Error("Video not found");
    }

    const validStatuses = ["pendente", "processando", "enviado", "falhou"];

    if (!validStatuses.includes(status)) {
      throw new Error("Invalid status");
    }

    return repository.createLog({ ...payload, status });
  }

  async function updateStatus(id, status, mensagemErro = null) {
    if (!id) {
      throw new Error("Dispatch log id is required");
    }

    const validStatuses = ["pendente", "processando", "enviado", "falhou"];

    if (!validStatuses.includes(status)) {
      throw new Error("Invalid status");
    }

    return repository.updateStatus(id, status, mensagemErro);
  }

  async function listByCampaign(campaignId) {
    if (!campaignId) {
      throw new Error("Campaign id is required");
    }

    return repository.listByCampaign(campaignId);
  }

  async function listByGroup(groupId) {
    if (!groupId) {
      throw new Error("Group id is required");
    }

    return repository.listByGroup(groupId);
  }

  async function listRecent(limit = 10) {
    return repository.listRecent(limit);
  }

  return {
    createLog,
    listByCampaign,
    listByGroup,
    listRecent,
    updateStatus,
  };
}

module.exports = createDispatchLogsService();
module.exports.createDispatchLogsService = createDispatchLogsService;
