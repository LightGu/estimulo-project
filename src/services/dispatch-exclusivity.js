// Exclusividade entre o disparador pontual e as campanhas de video.
//
// O conflito de janela (campaign-window-conflict.js) so bloqueia quando as duas
// campanhas disputam os MESMOS grupos. Isso nao basta: a instancia do WhatsApp e
// uma so, e um envio de texto no meio de uma campanha de video concorre pela
// mesma sessao do Baileys, ainda que para grupos diferentes. A regra aqui e mais
// dura e nao olha grupo nenhum - enquanto houver campanha de video em voo,
// mensagem pontual nao sai.
//
// Sao dois pontos de aplicacao, porque nenhum dos dois sozinho resolve:
//
// - No agendamento (`assertNoVideoCampaignInWindow`): recusa a janela na hora em
//   que o usuario a escolhe, com mensagem explicando qual campanha ocupa o
//   periodo.
// - Na execucao (`resolveAdHocDispatchBlock`): a campanha de video pode ter sido
//   criada depois do agendamento do pontual, ou ter estourado a janela. O worker
//   consulta de novo no momento do envio e adia o job em vez de mandar por cima.

const AD_HOC_CAMPAIGN_TYPE = "pontual";

// Folga depois do fim da janela da campanha de video antes de liberar o pontual.
const DEFAULT_RESUME_BUFFER_MS = 60 * 1000;
// Teto de adiamentos por job. Sem ele, uma campanha de video que ficasse ativa
// indefinidamente manteria o pontual quicando na fila para sempre, sem nunca
// aparecer como problema no relatorio.
const DEFAULT_MAX_POSTPONEMENTS = 12;

function toTime(value) {
  if (!value) {
    return null;
  }

  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();

  return Number.isNaN(time) ? null : time;
}

function isVideoCampaign(campaign) {
  return Boolean(campaign) && String(campaign.tipo || "").toLowerCase() !== AD_HOC_CAMPAIGN_TYPE;
}

function formatWindow(campaign, timezone) {
  const format = (value) => {
    const time = toTime(value);

    if (time === null) {
      return "?";
    }

    return new Date(time).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone || undefined,
    });
  };

  return `${format(campaign.window_start)} - ${format(campaign.window_end)}`;
}

// Campanhas de video ativas cuja janela cruza o intervalo pedido. Reaproveita a
// mesma consulta do conflito por grupo; a diferenca e que aqui nada e filtrado
// por grupo depois.
async function listOverlappingVideoCampaigns(params = {}) {
  const { campaignsRepository, windowStart, windowEnd, excludeId } = params;

  if (!campaignsRepository || typeof campaignsRepository.listActiveOverlappingWindow !== "function") {
    return [];
  }

  if (!windowStart || !windowEnd) {
    return [];
  }

  const candidates = await campaignsRepository.listActiveOverlappingWindow(windowStart, windowEnd, { excludeId });

  return (candidates || []).filter(isVideoCampaign);
}

// Roda antes de persistir o agendamento pontual: se conflitar, nada e criado.
async function assertNoVideoCampaignInWindow(params = {}) {
  const conflicts = await listOverlappingVideoCampaigns(params);

  if (!conflicts.length) {
    return;
  }

  const detail = conflicts
    .map((campaign) => `"${campaign.trilha}" (${formatWindow(campaign, params.timezone)})`)
    .join("; ");

  const error = new Error(
    `A janela escolhida coincide com campanha de video em andamento: ${detail}. ` +
      "O disparo pontual usa o mesmo numero de WhatsApp da campanha, entao precisa ficar fora desse periodo."
  );

  error.code = "CAMPAIGN_WINDOW_CONFLICT";
  error.conflicts = conflicts.map((campaign) => ({
    campaign_id: campaign.id,
    trilha: campaign.trilha,
    window_start: campaign.window_start,
    window_end: campaign.window_end,
    group_ids: [],
  }));

  throw error;
}

// Consultado pelo worker no momento exato do envio. Devolve `null` quando o
// caminho esta livre, ou o motivo e o instante em que o job deve ser retomado.
async function resolveAdHocDispatchBlock(params = {}) {
  const { campaignsRepository, at = new Date(), resumeBufferMs = DEFAULT_RESUME_BUFFER_MS } = params;
  const atTime = toTime(at);

  if (atTime === null) {
    return null;
  }

  // Olha `resumeBufferMs` para a FRENTE, nao so o instante atual.
  //
  // Antes a consulta era [agora, agora+1ms]: uma campanha de video cuja janela
  // comecava dali a alguns segundos nao aparecia, e a mensagem pontual saia
  // colada no inicio dela - exatamente a disputa pela sessao do WhatsApp que
  // este modulo existe para evitar. Usar o mesmo buffer que ja governa a
  // retomada mantem a regra simetrica: se o pontual seria adiado ate
  // `fim + buffer`, ele tambem nao deve sair no `buffer` que antecede um inicio.
  const lookAheadMs = Number.isFinite(resumeBufferMs) && resumeBufferMs > 0 ? resumeBufferMs : 0;
  const inFlight = await listOverlappingVideoCampaigns({
    campaignsRepository,
    windowStart: new Date(atTime).toISOString(),
    windowEnd: new Date(atTime + lookAheadMs + 1).toISOString(),
  });

  if (!inFlight.length) {
    return null;
  }

  const latestEnd = inFlight.reduce((accumulator, campaign) => {
    const end = toTime(campaign.window_end);

    return end !== null && end > accumulator ? end : accumulator;
  }, atTime);

  return {
    campaign: inFlight[0],
    campaigns: inFlight,
    resumeAt: new Date(latestEnd + resumeBufferMs),
    reason: `campanha de video "${inFlight[0].trilha}" em andamento`,
  };
}

module.exports = {
  AD_HOC_CAMPAIGN_TYPE,
  DEFAULT_MAX_POSTPONEMENTS,
  DEFAULT_RESUME_BUFFER_MS,
  assertNoVideoCampaignInWindow,
  isVideoCampaign,
  listOverlappingVideoCampaigns,
  resolveAdHocDispatchBlock,
};
