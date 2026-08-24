const defaultNotificationsRepository = require("../repositories/notifications.repository");

const TRAIL_FINISHED_TYPE = "trail_finished";
const TRAIL_ADVANCED_TYPE = "trail_advanced";

const TRAIL_ADVANCED_REASON_LABEL = {
  sequencia: "trilha seguinte da jornada",
  setor_desvio: "desvio por setor",
  checkpoint_perfil: "novo perfil da jornada",
};

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

  async function clearRead() {
    await repository.deleteRead();

    return { cleared: true };
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

  // Disparada pelo avanco automatico de trilha (group-video-flow.js) sempre que o
  // motor de sequenciamento reatribui trilha_id sozinho - espelha
  // notifyTrailFinished, distinguindo passo normal / desvio por setor / checkpoint
  // de perfil na mensagem.
  async function notifyTrailAdvanced({ groupId, groupName, toTrilhaLabel, reason } = {}) {
    const groupLabel = groupName || groupId;
    const reasonLabel = TRAIL_ADVANCED_REASON_LABEL[reason];
    const destino = toTrilhaLabel ? `para a trilha "${toTrilhaLabel}"` : "para a próxima trilha da jornada";
    const message = reasonLabel
      ? `O grupo "${groupLabel}" avançou automaticamente ${destino} (${reasonLabel}).`
      : `O grupo "${groupLabel}" avançou automaticamente ${destino}.`;

    return repository.create({
      type: TRAIL_ADVANCED_TYPE,
      message,
      group_id: groupId || null,
    });
  }

  return {
    list,
    markAllRead,
    markRead,
    clearRead,
    notifyTrailAdvanced,
    notifyTrailFinished,
  };
}

module.exports = createInAppNotificationsService();
module.exports.TRAIL_ADVANCED_TYPE = TRAIL_ADVANCED_TYPE;
module.exports.TRAIL_FINISHED_TYPE = TRAIL_FINISHED_TYPE;
