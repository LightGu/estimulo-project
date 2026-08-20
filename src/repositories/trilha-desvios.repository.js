function getClient(client) {
  return client || require("../database/client");
}

async function listByProfile(profileId, client) {
  const { data, error } = await getClient(client)
    .from("trilha_perfil_desvios")
    .select("*")
    .eq("profile_id", profileId)
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

async function listAll(client) {
  const { data, error } = await getClient(client).from("trilha_perfil_desvios").select("*");

  if (error) {
    throw error;
  }

  return data || [];
}

async function findById(id, client) {
  const { data, error } = await getClient(client)
    .from("trilha_perfil_desvios")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function create(payload, client) {
  const { data, error } = await getClient(client)
    .from("trilha_perfil_desvios")
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function remove(id, client) {
  const { data, error } = await getClient(client)
    .from("trilha_perfil_desvios")
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
  findById,
  listAll,
  listByProfile,
  remove,
};
