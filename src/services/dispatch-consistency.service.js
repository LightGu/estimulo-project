const dispatchLogsRepository = require("../repositories/dispatch-logs.repository");
const groupVideoProgressRepository = require("../repositories/group-video-progress.repository");
const campaignsRepository = require("../repositories/campaigns.repository");
const groupsRepository = require("../repositories/groups.repository");
const videoCatalogRepository = require("../repositories/video-catalog.repository");

function createDispatchConsistencyService(dependencies = {}) {
  const dispatchLogsRepositoryDependency = dependencies.dispatchLogsRepository || dispatchLogsRepository;
  const groupVideoProgressRepositoryDependency = dependencies.groupVideoProgressRepository || groupVideoProgressRepository;
  const campaignsRepositoryDependency = dependencies.campaignsRepository || campaignsRepository;
  const groupsRepositoryDependency = dependencies.groupsRepository || groupsRepository;
  const videoCatalogRepositoryDependency = dependencies.videoCatalogRepository || videoCatalogRepository;

  async function ensureDispatchEntities(campaignId, groupId, videoId) {
    if (!campaignId) {
      throw new Error("Campaign id is required");
    }

    if (!groupId) {
      throw new Error("Group id is required");
    }

    const campaign = await campaignsRepositoryDependency.findById(campaignId);

    if (!campaign) {
      throw new Error("Campaign not found");
    }

    const group = await groupsRepositoryDependency.findById(groupId);

    if (!group) {
      throw new Error("Group not found");
    }

    if (!videoId) {
      return { campaign, group };
    }

    const video = await videoCatalogRepositoryDependency.findById(videoId);

    if (!video) {
      throw new Error("Video not found");
    }

    return { campaign, group, video };
  }

  async function findExistingLog(campaignId, groupId, videoId, statuses = ["pendente", "processando", "enviado", "falhou"]) {
    const logs = await dispatchLogsRepositoryDependency.listByCampaign(campaignId);

    return (logs || []).find((entry) => {
      if (entry.group_id !== groupId) {
        return false;
      }

      if (videoId && entry.video_id !== videoId) {
        return false;
      }

      return statuses.includes(entry.status);
    }) || null;
  }

  async function createAttemptLog(payload) {
    const existing = await findExistingLog(payload.campaignId, payload.groupId, payload.videoId, ["processando"]);

    if (existing) {
      return { log: existing, created: false, skipSend: true };
    }

    const existingPending = await findExistingLog(payload.campaignId, payload.groupId, payload.videoId, ["pendente"]);

    if (existingPending) {
      return { log: existingPending, created: false, skipSend: false };
    }

    const log = await dispatchLogsRepositoryDependency.createLog({
      campaign_id: payload.campaignId,
      group_id: payload.groupId,
      video_id: payload.videoId,
      status: "pendente",
      mensagem_erro: null,
    });

    return { log, created: true, skipSend: false };
  }

  async function registerProgress(groupId, videoId) {
    if (!groupId || !videoId) {
      return null;
    }

    const duplicate = await groupVideoProgressRepositoryDependency.hasDuplicate(groupId, videoId);

    if (duplicate) {
      return { duplicate: true, record: null };
    }

    const record = await groupVideoProgressRepositoryDependency.registerDelivery({
      group_id: groupId,
      video_id: videoId,
    });

    return { duplicate: false, record };
  }

  async function executeDispatch(options = {}) {
    const {
      campaignId,
      groupId,
      videoId,
      sender,
      deliveryPayload,
    } = options;

    await ensureDispatchEntities(campaignId, groupId, videoId);

    const completedLog = await findExistingLog(campaignId, groupId, videoId, ["enviado"]);

    if (completedLog) {
      return {
        idempotent: true,
        status: "enviado",
        skippedSend: true,
        logId: completedLog.id,
      };
    }

    const { log, skipSend } = await createAttemptLog({
      campaignId,
      groupId,
      videoId,
    });

    if (skipSend) {
      return {
        idempotent: true,
        status: "processando",
        skippedSend: true,
        logId: log.id,
      };
    }

    await dispatchLogsRepositoryDependency.updateStatus(log.id, "processando");

    try {
      const result = await sender(deliveryPayload);

      await registerProgress(groupId, videoId);
      await dispatchLogsRepositoryDependency.updateStatus(log.id, "enviado");

      return {
        idempotent: false,
        status: "enviado",
        skippedSend: false,
        logId: log.id,
        result,
      };
    } catch (error) {
      await dispatchLogsRepositoryDependency.updateStatus(log.id, "falhou", error.message || String(error));
      throw error;
    }
  }

  return {
    executeDispatch,
  };
}

module.exports = createDispatchConsistencyService();
module.exports.createDispatchConsistencyService = createDispatchConsistencyService;
