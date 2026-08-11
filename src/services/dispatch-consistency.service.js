const dispatchLogsRepository = require("../repositories/dispatch-logs.repository");
const groupVideoProgressRepository = require("../repositories/group-video-progress.repository");
const campaignsRepository = require("../repositories/campaigns.repository");
const groupsRepository = require("../repositories/groups.repository");
const videoCatalogRepository = require("../repositories/video-catalog.repository");
const defaultSettingsService = require("./settings.service");
// Regra compartilhada com o disparo pontual - ver delivery-confirmation.js.
const { assertDeliveryConfirmed, extractProviderDelivery } = require("./delivery-confirmation");

function writeStageLog(logger, level, event, payload = {}) {
  const writer = logger && (logger[level] || logger.info);

  if (typeof writer !== "function") {
    return;
  }

  writer.call(logger, JSON.stringify({ event, ...payload }));
}

function createDispatchConsistencyService(dependencies = {}) {
  const dispatchLogsRepositoryDependency = dependencies.dispatchLogsRepository || dispatchLogsRepository;
  const groupVideoProgressRepositoryDependency = dependencies.groupVideoProgressRepository || groupVideoProgressRepository;
  const campaignsRepositoryDependency = dependencies.campaignsRepository || campaignsRepository;
  const groupsRepositoryDependency = dependencies.groupsRepository || groupsRepository;
  const videoCatalogRepositoryDependency = dependencies.videoCatalogRepository || videoCatalogRepository;
  const settingsService = dependencies.settingsService || defaultSettingsService;
  const logger = dependencies.logger || console;

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

  async function registerProgress(groupId, videoId, trilhaId, options = {}) {
    if (!groupId || !videoId) {
      return null;
    }

    const duplicate = await groupVideoProgressRepositoryDependency.hasDuplicate(groupId, videoId);
    let record;

    if (duplicate) {
      if (options.neverRepeatVideo === false) {
        record = await groupVideoProgressRepositoryDependency.upsertDelivery({
          group_id: groupId,
          video_id: videoId,
          trilha_id: trilhaId || null,
        });
      } else {
        return { duplicate: true, record: null };
      }
    } else {
      record = await groupVideoProgressRepositoryDependency.registerDelivery({
        group_id: groupId,
        video_id: videoId,
        trilha_id: trilhaId || null,
      });
    }

    const groupUpdate = { ...(trilhaId ? { trilha_id: trilhaId } : {}) };

    if (options.forcedNextVideoId && options.forcedNextVideoId === videoId) {
      groupUpdate.forced_next_video_id = null;
    }

    if (Object.keys(groupUpdate).length > 0) {
      await groupsRepositoryDependency.update(groupId, groupUpdate);
    }

    return { duplicate: false, record };
  }

  // Best-effort: a mensagem ja saiu e o log ja esta "enviado". Se o registro da
  // evidencia falhar, perde-se a rastreabilidade daquele envio - nunca o envio.
  async function recordProviderDelivery(logId, result, context = {}) {
    if (!logId || typeof dispatchLogsRepositoryDependency.updateProviderDelivery !== "function") {
      return;
    }

    try {
      await dispatchLogsRepositoryDependency.updateProviderDelivery(logId, extractProviderDelivery(result));
    } catch (error) {
      writeStageLog(logger, "error", "dispatch_consistency.record_provider_delivery_failed", {
        ...context,
        log_id: logId,
        error_message: error.message || String(error),
      });
    }
  }

  async function markCampaignFailed(campaignId) {
    let autoRetryFailures = false;

    try {
      const dispatchRules = await settingsService.getDispatchRulesSettings();
      autoRetryFailures = Boolean(dispatchRules.auto_retry_failures);
    } catch (error) {
      autoRetryFailures = false;
    }

    // Quando o reprocessamento automatico de falhas esta ativo, o worker de retry
    // (dispatch-failure-retry.js) e quem decide o destino do log "falhou"; manter a
    // campanha ativa evita que ela seja desativada antes do proximo reprocessamento.
    if (autoRetryFailures) {
      return;
    }

    if (campaignsRepositoryDependency && typeof campaignsRepositoryDependency.update === "function") {
      await campaignsRepositoryDependency.update(campaignId, { ativo: false });
    }
  }

  async function executeDispatch(options = {}) {
    const {
      campaignId,
      groupId,
      videoId,
      trilhaId,
      sender,
      deliveryPayload,
      neverRepeatVideo,
      forcedNextVideoId,
    } = options;

    writeStageLog(logger, "info", "dispatch_consistency.ensure_entities.started", {
      campaign_id: campaignId,
      group_id: groupId,
      video_id: videoId,
    });
    await ensureDispatchEntities(campaignId, groupId, videoId);
    writeStageLog(logger, "info", "dispatch_consistency.ensure_entities.completed", {
      campaign_id: campaignId,
      group_id: groupId,
      video_id: videoId,
    });

    writeStageLog(logger, "info", "dispatch_consistency.find_completed_log.started", {
      campaign_id: campaignId,
      group_id: groupId,
      video_id: videoId,
    });
    const completedLog = await findExistingLog(campaignId, groupId, videoId, ["enviado"]);
    writeStageLog(logger, "info", "dispatch_consistency.find_completed_log.completed", {
      campaign_id: campaignId,
      group_id: groupId,
      video_id: videoId,
      log_id: completedLog && completedLog.id,
    });

    if (completedLog) {
      return {
        idempotent: true,
        status: "enviado",
        skippedSend: true,
        logId: completedLog.id,
      };
    }

    writeStageLog(logger, "info", "dispatch_consistency.create_attempt_log.started", {
      campaign_id: campaignId,
      group_id: groupId,
      video_id: videoId,
    });
    const { log, skipSend } = await createAttemptLog({
      campaignId,
      groupId,
      videoId,
    });
    writeStageLog(logger, "info", "dispatch_consistency.create_attempt_log.completed", {
      campaign_id: campaignId,
      group_id: groupId,
      video_id: videoId,
      log_id: log && log.id,
      skipped_send: skipSend,
    });

    if (skipSend) {
      return {
        idempotent: true,
        status: "processando",
        skippedSend: true,
        logId: log.id,
      };
    }

    writeStageLog(logger, "info", "dispatch_consistency.mark_processing.started", {
      campaign_id: campaignId,
      group_id: groupId,
      video_id: videoId,
      log_id: log.id,
    });
    await dispatchLogsRepositoryDependency.updateStatus(log.id, "processando");
    writeStageLog(logger, "info", "dispatch_consistency.mark_processing.completed", {
      campaign_id: campaignId,
      group_id: groupId,
      video_id: videoId,
      log_id: log.id,
    });

    try {
      writeStageLog(logger, "info", "dispatch_consistency.sender.started", {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
        log_id: log.id,
      });
      const result = await sender(deliveryPayload);
      writeStageLog(logger, "info", "dispatch_consistency.sender.completed", {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
        log_id: log.id,
      });
      assertDeliveryConfirmed(result);

      writeStageLog(logger, "info", "dispatch_consistency.mark_sent.started", {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
        log_id: log.id,
      });
      await dispatchLogsRepositoryDependency.updateStatus(log.id, "enviado");
      writeStageLog(logger, "info", "dispatch_consistency.mark_sent.completed", {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
        log_id: log.id,
      });

      await recordProviderDelivery(log.id, result, {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
      });

      writeStageLog(logger, "info", "dispatch_consistency.progress.started", {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
        log_id: log.id,
      });
      const progress = await registerProgress(groupId, videoId, trilhaId, { neverRepeatVideo, forcedNextVideoId });
      writeStageLog(logger, "info", "dispatch_consistency.progress.completed", {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
        log_id: log.id,
        duplicate: Boolean(progress && progress.duplicate),
      });

      return {
        idempotent: false,
        status: "enviado",
        skippedSend: false,
        logId: log.id,
        progress,
        result,
      };
    } catch (error) {
      writeStageLog(logger, "error", "dispatch_consistency.failed", {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
        log_id: log.id,
        error_message: error.message || String(error),
      });
      await markCampaignFailed(campaignId);
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
module.exports.assertDeliveryConfirmed = assertDeliveryConfirmed;
