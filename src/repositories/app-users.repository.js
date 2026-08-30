function getClient(client) {
  return client || require("../database/client");
}

const PUBLIC_COLUMNS = "id, username, display_name, active, is_admin, created_at, updated_at, last_login_at";

async function findByUsername(username, client) {
  const { data, error } = await getClient(client)
    .from("app_users")
    .select("*")
    .eq("username", username)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function findById(id, client) {
  const { data, error } = await getClient(client)
    .from("app_users")
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
    .from("app_users")
    .select(PUBLIC_COLUMNS)
    .order("username", { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

async function create(payload, client) {
  const { data, error } = await getClient(client)
    .from("app_users")
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
    .from("app_users")
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
    .from("app_users")
    .delete()
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function touchLastLogin(id, client) {
  const { data, error } = await getClient(client)
    .from("app_users")
    .update({ last_login_at: new Date().toISOString() })
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
  findByUsername,
  remove,
  touchLastLogin,
  update,
};
