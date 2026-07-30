const defaultSettingsService = require("./settings.service");
const defaultGroupsRepository = require("../repositories/groups.repository");
const { isTestEnvironment, parseBooleanEnv } = require("../config/notifications");
const { sendToEvolution } = require("./evolution");

const AI_STAGE_LABELS = {
  transcricao: "transcrição",
  legenda: "legenda",
  revisao: "revisão",
};

function createNotificationsService(dependencies = {}) {
  const settingsService = dependencies.settingsService || defaultSettingsService;
  const groupsRepository = dependencies.groupsRepository || defaultGroupsRepository;
  const sender = dependencies.sendToEvolution || sendToEvolution;
  const logger = dependencies.logger || console;
  const hasInjectedSender = Boolean(dependencies.sendToEvolution);

  // Ordem de precedencia: NOTIFICATIONS_ENABLED sempre vence (o dry-run nao pode
  // ser furado por um sender injetado). Sem a env, um sender injetado significa
  // que o chamador controla o destino (testes que verificam o payload), entao
  // liberamos; caso contrario o envio real e bloqueado em contexto de teste.
  const isEnabled =
    dependencies.isEnabled ||
    function resolveEnabled() {
      const explicit = parseBooleanEnv(process.env.NOTIFICATIONS_ENABLED);

      if (explicit !== null) {
        return explicit;
      }

      return hasInjectedSender || !isTestEnvironment();
    };

  async function resolveNotificationTarget(settings) {
    const groupId = settings && settings.notification_group_id;

    if (!groupId) {
      return null;
    }

    const group = await groupsRepository.findById(groupId);

    if (!group || !group.evolution_group_id) {
      logger.warn &&
        logger.warn(
          JSON.stringify({
            event: "notifications.target_unresolved",
            notification_group_id: groupId,
            reason: !group ? "group_not_found" : "missing_evolution_group_id",
          })
        );

      return null;
    }

    return group;
  }

  async function dispatchMessage(message, context, eventKey) {
    if (!isEnabled()) {
      logger.warn &&
        logger.warn(
          JSON.stringify({
            event: "notifications.skipped_disabled",
            reason: "outbound_notifications_disabled",
            ...context,
          })
        );

      return { sent: false, reason: "notifications_disabled" };
    }

    try {
      const settings = await settingsService.getNotificationSettings();

      if (settings.events && settings.events[eventKey] === false) {
        return { sent: false, reason: "event_disabled" };
      }

      const group = await resolveNotificationTarget(settings);

      if (!group) {
        return { sent: false, reason: "no_notification_group_configured" };
      }

      await sender({ groupId: group.evolution_group_id, message });

      logger.info &&
        logger.info(
          JSON.stringify({ event: "notifications.sent", notification_group_id: group.id, ...context })
        );

      return { sent: true };
    } catch (error) {
      logger.error &&
        logger.error(
          JSON.stringify({
            event: "notifications.send_failed",
            error_message: error.message,
            ...context,
          })
        );

      return { sent: false, reason: "send_failed", error_message: error.message };
    }
  }

  async function notifyCampaignStarted({ campaignId, campaignLabel, groupsCount } = {}) {
    const label = campaignLabel || campaignId;
    const message = `Campanha "${label}" iniciada. ${groupsCount} grupo(s) programado(s) para envio.`;

    return dispatchMessage(message, { event: "campaign_started", campaign_id: campaignId }, "campaignStarted");
  }

  async function notifyCampaignFinished({ campaignId, campaignLabel } = {}) {
    const label = campaignLabel || campaignId;
    const message = `Campanha "${label}" concluída.`;

    return dispatchMessage(message, { event: "campaign_finished", campaign_id: campaignId }, "campaignFinished");
  }

  async function notifyDispatchFailure({ campaignId, groupId, videoId, errorMessage, campaignLabel } = {}) {
    const label = campaignLabel || campaignId;
    const message = `Falha no envio da campanha "${label}" para o grupo ${groupId}: ${errorMessage}`;

    return dispatchMessage(
      message,
      { event: "dispatch_failure", campaign_id: campaignId, group_id: groupId, video_id: videoId },
      "dispatchFailure"
    );
  }

  async function notifyAiError({ campaignId, groupId, videoId, stage, errorMessage, campaignLabel } = {}) {
    const label = campaignLabel || campaignId;
    const stageLabel = AI_STAGE_LABELS[stage] || stage || "IA";
    const message = `Erro na IA (${stageLabel}) na campanha "${label}": ${errorMessage}`;

    return dispatchMessage(
      message,
      { event: "ai_error", campaign_id: campaignId, group_id: groupId, video_id: videoId, stage },
      "aiError"
    );
  }

  return {
    notifyCampaignStarted,
    notifyCampaignFinished,
    notifyDispatchFailure,
    notifyAiError,
  };
}

module.exports = createNotificationsService();
module.exports.createNotificationsService = createNotificationsService;
