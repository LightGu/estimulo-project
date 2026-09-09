function getClient(client) {
  return client || require("../database/client");
}

const TERMINAL_LOG_STATUSES = ["enviado", "falhou", "cancelado"];

async function listGroups(campaignId, client) {
  const { data, error } = await getClient(client)
    .from("campaign_groups")
    .select("*, groups(*)")
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function associateGroup(campaignId, groupId, organizationId, client) {
  const { data, error } = await getClient(client)
    .from("campaign_groups")
    .insert({ campaign_id: campaignId, group_id: groupId, organization_id: organizationId })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function removeGroup(campaignId, groupId, client) {
  const { data, error } = await getClient(client)
    .from("campaign_groups")
    .delete()
    .eq("campaign_id", campaignId)
    .eq("group_id", groupId)
    .select("*")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

// Roda depois de CADA envio (maybeNotifyCampaignFinished em queues/dispatch.js).
//
// Antes carregava todos os logs da campanha com select("*") para depois reduzir
// em memoria - a quarta varredura completa da tabela `logs` por grupo enviado.
// Agora sao duas consultas que nao transferem linha de log: uma contagem e uma
// lista de group_id distintos.
//
// A regra tambem ficou mais correta. A versao antiga olhava o status do log MAIS
// RECENTE de cada grupo; com duas linhas para o mesmo trio (a corrida corrigida
// pelo indice idx_logs_trio_ativo), uma linha "pendente" orfa mais nova
// escondia o "enviado" real e a campanha nunca era considerada concluida. Agora
// a pergunta e' direta: sobrou algum log NAO terminal, e todos os grupos
// associados ja tem algum log terminal?
async function isCampaignFullyTerminal(campaignId, options = {}) {
  const dispatchLogsRepositoryDependency = options.dispatchLogsRepository || require("./dispatch-logs.repository");
  const client = options.client;

  const groupRows = await listGroups(campaignId, client);

  if (!groupRows.length) {
    return false;
  }

  const canUseTargetedQueries =
    typeof dispatchLogsRepositoryDependency.countNonTerminalByCampaign === "function" &&
    typeof dispatchLogsRepositoryDependency.listTerminalGroupIdsByCampaign === "function";

  if (canUseTargetedQueries) {
    const [pendingCount, terminalGroupIds] = await Promise.all([
      dispatchLogsRepositoryDependency.countNonTerminalByCampaign(campaignId, TERMINAL_LOG_STATUSES, client),
      dispatchLogsRepositoryDependency.listTerminalGroupIdsByCampaign(campaignId, TERMINAL_LOG_STATUSES, client),
    ]);

    if (pendingCount > 0) {
      return false;
    }

    const terminalGroups = new Set(terminalGroupIds);

    return groupRows.every((row) => terminalGroups.has(row.group_id));
  }

  // Fallback para repositorios injetados em teste que so tem listByCampaign.
  const logs = await dispatchLogsRepositoryDependency.listByCampaign(campaignId, client);
  const latestStatusByGroup = new Map();

  logs.forEach((log) => {
    if (!latestStatusByGroup.has(log.group_id)) {
      latestStatusByGroup.set(log.group_id, log.status);
    }
  });

  return groupRows.every((row) => {
    const status = latestStatusByGroup.get(row.group_id);
    return status && TERMINAL_LOG_STATUSES.includes(status);
  });
}

module.exports = {
  associateGroup,
  isCampaignFullyTerminal,
  listGroups,
  removeGroup,
  TERMINAL_LOG_STATUSES,
};
