const defaultSupabaseClient = require("../database/client");

function getClient(client = defaultSupabaseClient) {
  return client;
}

async function findById(id, client = defaultSupabaseClient) {
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

async function findAll(client = defaultSupabaseClient) {
  const { data, error } = await getClient(client)
    .from("campaigns")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function listActive(client = defaultSupabaseClient) {
  const { data, error } = await getClient(client)
    .from("campaigns")
    .select("*")
    .eq("ativo", true)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function listByOrganization(organizationId, client = defaultSupabaseClient) {
  const { data, error } = await getClient(client)
    .from("campaigns")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function create(payload, client = defaultSupabaseClient) {
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

async function update(id, payload, client = defaultSupabaseClient) {
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

async function remove(id, client = defaultSupabaseClient) {
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
