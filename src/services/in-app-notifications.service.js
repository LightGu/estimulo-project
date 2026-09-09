const defaultNotificationsRepository = require("../repositories/notifications.repository");

const TRAIL_FINISHED_TYPE = "trail_finished";
const TRAIL_ADVANCED_TYPE = "trail_advanced";
const CAMPAIGN_STUCK_TYPE = "campaign_stuck_generating_captions";

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

  /*
    Campanha parada em "gerando_legendas" ha tempo demais.

    A geracao de legendas roda como promise solta dentro do processo da API
    (dispatchCampaign inicia e nao aguarda). Se a API reiniciar no meio - e o
    deploy recria os containers - o trabalho morre com o processo e nao ha estado
    de onde retomar: a campanha fica em "gerando_legendas" para sempre.

    O sweep de dispatch-review-timeout ate encontrava essas campanhas, mas saia
    cedo quando `auto_send_after_timeout.enabled` era false - que e' o DEFAULT.
    Ou seja: na configuracao padrao, uma campanha travada era completamente
    invisivel. O operador via "Processando" e nao tinha como saber que ninguem
    mais ia processar.

    Esta notificacao nao retoma nada de proposito: retomar sozinha uma campanha
    abandonada significa montar uma janela nova e disparar para todos os grupos,
    que e' exatamente o que gerou spam a cada boot antes do teto de idade. A
    decisao continua sendo do operador - o que muda e' que agora ele sabe que
    precisa toma-la.
  */
  async function notifyCampaignStuckGeneratingCaptions({ campaignId, campaignLabel, ageHours } = {}) {
    const label = campaignLabel || campaignId;
    const idade = Number.isFinite(ageHours) ? ` ha ${ageHours}h` : "";
    const message =
      `A campanha "${label}" esta parada na geração de legendas${idade} e não vai continuar sozinha. ` +
      "Isso acontece quando a geração é interrompida (por exemplo, um reinício do servidor). " +
      "Abra a campanha para revisar as legendas e iniciar o envio, ou cancele-a.";

    return repository.create({
      type: CAMPAIGN_STUCK_TYPE,
      message,
      group_id: null,
    });
  }

  return {
    list,
    markAllRead,
    markRead,
    clearRead,
    notifyCampaignStuckGeneratingCaptions,
    notifyTrailAdvanced,
    notifyTrailFinished,
  };
}

module.exports = createInAppNotificationsService();
module.exports.CAMPAIGN_STUCK_TYPE = CAMPAIGN_STUCK_TYPE;
module.exports.TRAIL_ADVANCED_TYPE = TRAIL_ADVANCED_TYPE;
module.exports.TRAIL_FINISHED_TYPE = TRAIL_FINISHED_TYPE;
