function getClient(client) {
  return client || require("../database/client");
}

async function findById(id, client) {
  const { data, error } = await getClient(client)
    .from("groups")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function findByEvolutionGroupId(evolutionGroupId, client) {
  const { data, error } = await getClient(client)
    .from("groups")
    .select("*")
    .eq("evolution_group_id", evolutionGroupId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function findAll(client) {
  const { data, error } = await getClient(client)
    .from("groups")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function listByOrganization(organizationId, client) {
  const { data, error } = await getClient(client)
    .from("groups")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function listVideoEnabled(client) {
  const { data, error } = await getClient(client)
    .from("groups")
    .select("*")
    .eq("envia_video", true)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function listWithoutSegment(params, client) {
  const options = params && typeof params === "object" && !params.from ? params : {};
  const databaseClient = params && typeof params === "object" && params.from ? params : client;
  let query = getClient(databaseClient)
    .from("groups")
    .select("*")
    .is("segmento", null)
    .order("created_at", { ascending: false });

  const nameContains = String(options.name_contains || options.nameContains || "").trim();

  if (nameContains) {
    query = query.ilike("nome", `%${nameContains}%`);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return data || [];
}

async function searchByName(params = {}, client) {
  let query = getClient(client)
    .from("groups")
    .select("*")
    .order("created_at", { ascending: false });

  const nameContains = String(params.name_contains || params.nameContains || "").trim();

  if (nameContains) {
    query = query.ilike("nome", `%${nameContains}%`);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return data || [];
}

async function create(payload, client) {
  const { data, error } = await getClient(client)
    .from("groups")
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function update(id, payload, client) {
  const { data, error } = await getClient(client)
    .from("groups")
    .update(payload)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

// Compare-and-swap: so aplica o update se trilha_id ainda for o valor esperado no
// momento da leitura. Usado pelo avanco automatico de trilha (group-video-flow.js)
// para nao corromper o progresso quando dois ticks de disparo sobrepostos (ou duas
// campanhas) leem o mesmo grupo e tentam avancar ao mesmo tempo - quem perde a
// corrida recebe null e pula o avanco nesta rodada em vez de sobrescrever o outro.
async function updateTrilhaIfCurrent(id, expectedTrilhaId, payload, client) {
  const resolvedClient = getClient(client);
  let query = resolvedClient.from("groups").update(payload).eq("id", id);

  query = expectedTrilhaId === null ? query.is("trilha_id", null) : query.eq("trilha_id", expectedTrilhaId);

  const { data, error } = await query.select("*").maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function remove(id, client) {
  const { data, error } = await getClient(client)
    .from("groups")
    .delete()
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function countByTrilhaId(trilhaId, client) {
  const { count, error } = await getClient(client)
    .from("groups")
    .select("*", { count: "exact", head: true })
    .eq("trilha_id", trilhaId);

  if (error) {
    throw error;
  }

  return count || 0;
}

module.exports = {
  countByTrilhaId,
  create,
  delete: remove,
  findAll,
  findByEvolutionGroupId,
  findById,
  listByOrganization,
  searchByName,
  listVideoEnabled,
  listWithoutSegment,
  remove,
  update,
  updateTrilhaIfCurrent,
};
