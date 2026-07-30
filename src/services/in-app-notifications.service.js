const defaultNotificationsRepository = require("../repositories/notifications.repository");

const TRAIL_FINISHED_TYPE = "trail_finished";

function createInAppNotificationsService(dependencies = {}) {
  const repository = dependencies.notificationsRepository || defaultNotificationsRepository;

  async function list({ limit = 20 } = {}) {
    const [items, unreadCount] = await Promise.all([repository.listRecent(limit), repository.countUnread()]);

    return { items, unread_count: unreadCount };
  }

  async function markAllRead() {
    await repository.markAllRead(new Date().toISOString());

    return { read: true };
  }

  async function markRead(id) {
    if (!id) {
      throw new Error("Notification id is required");
    }

    return repository.markRead(id, new Date().toISOString());
  }

  async function notifyTrailFinished({ groupId, groupName, trilhaLabel } = {}) {
    const groupLabel = groupName || groupId;
    const message = trilhaLabel
      ? `A trilha "${trilhaLabel}" foi concluída no grupo "${groupLabel}". Selecione uma nova trilha para continuar os envios.`
      : `A trilha do grupo "${groupLabel}" foi concluída. Selecione uma nova trilha para continuar os envios.`;

    return repository.create({
      type: TRAIL_FINISHED_TYPE,
      message,
      group_id: groupId || null,
    });
  }

  return {
    list,
    markAllRead,
    markRead,
    notifyTrailFinished,
  };
}

module.exports = createInAppNotificationsService();
module.exports.createInAppNotificationsService = createInAppNotificationsService;
module.exports.TRAIL_FINISHED_TYPE = TRAIL_FINISHED_TYPE;
