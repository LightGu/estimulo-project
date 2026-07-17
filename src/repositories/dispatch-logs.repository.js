function getClient(client) {
  return client || require("../database/client");
}

const LOGS_TABLE = "logs";

async function createLog(payload, client) {
  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function updateStatus(id, status, mensagemErro = null, client) {
  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .update({ status, mensagem_erro: mensagemErro })
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function listByCampaign(campaignId, client) {
  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .select("*")
    .eq("campaign_id", campaignId)
    .order("criado_em", { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function listByGroup(groupId, client) {
  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .select("*")
    .eq("group_id", groupId)
    .order("criado_em", { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function listRecent(limit = 10, client) {
  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .select("*")
    .order("criado_em", { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return data || [];
}

module.exports = {
  createLog,
  listByCampaign,
  listByGroup,
  listRecent,
  updateStatus,
};
