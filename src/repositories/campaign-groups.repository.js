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

async function isCampaignFullyTerminal(campaignId, options = {}) {
  const dispatchLogsRepositoryDependency = options.dispatchLogsRepository || require("./dispatch-logs.repository");
  const client = options.client;

  const groupRows = await listGroups(campaignId, client);

  if (!groupRows.length) {
    return false;
  }

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
