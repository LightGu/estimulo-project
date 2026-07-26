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

async function listWithFilters(filters = {}, client) {
  let query = getClient(client)
    .from(LOGS_TABLE)
    .select(
      "*, campaigns(id, trilha, data_envio, horario_envio), groups(id, nome, organization_id, organizations(id, nome)), video_catalog(id, nome_do_arquivo, trilha)"
    )
    .order("criado_em", { ascending: false });

  if (filters.startDate) {
    query = query.gte("criado_em", filters.startDate);
  }

  if (filters.endDate) {
    query = query.lte("criado_em", filters.endDate);
  }

  if (filters.groupId) {
    query = query.eq("group_id", filters.groupId);
  }

  if (filters.status) {
    query = query.eq("status", filters.status);
  }

  const { data, error } = await query;

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
  listWithFilters,
  updateStatus,
};
