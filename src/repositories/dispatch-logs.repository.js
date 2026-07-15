const defaultSupabaseClient = require("../database/client");

function getClient(client = defaultSupabaseClient) {
  return client;
}

async function createLog(payload, client = defaultSupabaseClient) {
  const { data, error } = await getClient(client)
    .from("dispatch_logs")
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function updateStatus(id, status, mensagemErro = null, client = defaultSupabaseClient) {
  const { data, error } = await getClient(client)
    .from("dispatch_logs")
    .update({ status, mensagem_erro: mensagemErro })
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function listByCampaign(campaignId, client = defaultSupabaseClient) {
  const { data, error } = await getClient(client)
    .from("dispatch_logs")
    .select("*")
    .eq("campaign_id", campaignId)
    .order("criado_em", { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function listByGroup(groupId, client = defaultSupabaseClient) {
  const { data, error } = await getClient(client)
    .from("dispatch_logs")
    .select("*")
    .eq("group_id", groupId)
    .order("criado_em", { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function listRecent(limit = 10, client = defaultSupabaseClient) {
  const { data, error } = await getClient(client)
    .from("dispatch_logs")
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
