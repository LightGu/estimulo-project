function getClient(client) {
  return client || require("../database/client");
}

async function findById(id, client) {
  const { data, error } = await getClient(client)
    .from("campaigns")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function findAll(client) {
  const { data, error } = await getClient(client)
    .from("campaigns")
    .select("*");

  if (error) {
    throw error;
  }

  return data || [];
}

async function listActive(client) {
  const { data, error } = await getClient(client)
    .from("campaigns")
    .select("*")
    .eq("ativo", true);

  if (error) {
    throw error;
  }

  return data || [];
}

async function listByOrganization(organizationId, client) {
  const { data, error } = await getClient(client)
    .from("campaigns")
    .select("*")
    .eq("organization_id", organizationId);

  if (error) {
    throw error;
  }

  return data || [];
}

async function create(payload, client) {
  const { data, error } = await getClient(client)
    .from("campaigns")
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
    .from("campaigns")
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
    .from("campaigns")
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
  findById,
  listActive,
  listByOrganization,
  remove,
  update,
};
