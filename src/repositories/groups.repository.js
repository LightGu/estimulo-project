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

module.exports = {
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
};
