// Duas campanhas so conflitam quando disputam o mesmo grupo na mesma janela.
// Janelas que se cruzam para grupos distintos continuam validas - e o caso
// legitimo de organizacoes diferentes disparando em paralelo. O que quebrava
// era a campanha criada por cima de outra sobre os mesmos grupos: as duas
// resolviam o "proximo video" do grupo e uma atropelava a outra.
//
// A regra vive aqui, e nao dentro de campaigns.service, porque o disparo pontual
// agendado (mensagens.service.scheduleAdHoc) cria campanha com janela do mesmo
// jeito. Com a checagem so no caminho de video, dava para agendar um pontual
// exatamente por cima da janela de uma campanha de video nos mesmos grupos -
// justamente o cenario que este guarda existe para impedir.

function formatConflictWindow(campaign, timezone) {
  const format = (value) => {
    if (!value) {
      return "?";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return "?";
    }

    return date.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZone: timezone || undefined,
    });
  };

  return `${format(campaign.window_start)} - ${format(campaign.window_end)}`;
}

function buildWindowConflictError(conflicts, timezone) {
  const detail = conflicts
    .map((conflict) => `"${conflict.campaign.trilha}" (${formatConflictWindow(conflict.campaign, timezone)})`)
    .join("; ");

  const error = new Error(
    `Ja existe campanha ativa no mesmo periodo para os grupos selecionados: ${detail}. ` +
      "Escolha outro horario ou remova os grupos em comum."
  );

  error.code = "CAMPAIGN_WINDOW_CONFLICT";
  error.conflicts = conflicts.map((conflict) => ({
    campaign_id: conflict.campaign.id,
    trilha: conflict.campaign.trilha,
    window_start: conflict.campaign.window_start,
    window_end: conflict.campaign.window_end,
    group_ids: conflict.groupIds,
  }));

  return error;
}

// Roda antes de criar a campanha: se conflitar, nada e persistido.
async function assertNoCampaignWindowConflict(params = {}) {
  const {
    campaignsRepository,
    campaignGroupsRepository,
    groupIds,
    windowStart,
    windowEnd,
    excludeId,
    timezone,
  } = params;

  if (!campaignsRepository || typeof campaignsRepository.listActiveOverlappingWindow !== "function") {
    return;
  }

  if (!Array.isArray(groupIds) || groupIds.length === 0 || !windowStart || !windowEnd) {
    return;
  }

  const candidates = await campaignsRepository.listActiveOverlappingWindow(windowStart, windowEnd, { excludeId });

  if (!candidates.length) {
    return;
  }

  const requestedGroupIds = new Set(groupIds);
  const conflicts = [];

  for (const campaign of candidates) {
    const rows = await campaignGroupsRepository.listGroups(campaign.id);
    const sharedGroupIds = rows
      .map((row) => row.group_id)
      .filter((groupId) => requestedGroupIds.has(groupId));

    if (sharedGroupIds.length) {
      conflicts.push({ campaign, groupIds: sharedGroupIds });
    }
  }

  if (conflicts.length) {
    throw buildWindowConflictError(conflicts, timezone);
  }
}

module.exports = {
  assertNoCampaignWindowConflict,
  buildWindowConflictError,
  formatConflictWindow,
};
