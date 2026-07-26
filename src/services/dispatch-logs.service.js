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

    const validStatuses = ["pendente", "processando", "enviado", "erro", "falhou"];

    if (!validStatuses.includes(status)) {
      throw new Error("Invalid status");
    }

    return repository.createLog({ ...payload, status });
  }

  async function updateStatus(id, status, mensagemErro = null) {
    if (!id) {
      throw new Error("Dispatch log id is required");
    }

    const validStatuses = ["pendente", "processando", "enviado", "erro", "falhou"];

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

  async function listForReport(filters = {}) {
    const { startDate, endDate, organizationId, groupId, status } = filters;
    const today = new Date().toISOString().slice(0, 10);

    if (startDate && startDate > today) {
      throw new Error("Start date cannot be in the future");
    }

    if (endDate && endDate > today) {
      throw new Error("End date cannot be in the future");
    }

    if (startDate && endDate && startDate > endDate) {
      throw new Error("Start date cannot be after end date");
    }

    const logs = await repository.listWithFilters({
      startDate: startDate ? `${startDate}T00:00:00.000Z` : null,
      endDate: endDate ? `${endDate}T23:59:59.999Z` : null,
      groupId: groupId || null,
      status: status || null,
    });

    if (!organizationId) {
      return logs;
    }

    return logs.filter((log) => log.groups?.organization_id === organizationId);
  }

  return {
    createLog,
    listByCampaign,
    listByGroup,
    listForReport,
    listRecent,
    updateStatus,
  };
}

module.exports = createDispatchLogsService();
module.exports.createDispatchLogsService = createDispatchLogsService;
