const defaultSupabaseClient = require("../database/client");

function getClient(client = defaultSupabaseClient) {
  return client;
}

async function findById(id, client = defaultSupabaseClient) {
  const { data, error } = await getClient(client)
    .from("organizations")
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
    .from("organizations")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function create(payload, client = defaultSupabaseClient) {
  const { data, error } = await getClient(client)
    .from("organizations")
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
    .from("organizations")
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
    .from("organizations")
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
  remove,
  update,
};
