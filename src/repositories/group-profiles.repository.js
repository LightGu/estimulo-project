function getClient(client) {
  return client || require("../database/client");
}

async function findAll(client) {
  const { data, error } = await getClient(client)
    .from("group_profiles")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

async function create(payload, client) {
  const { data, error } = await getClient(client)
    .from("group_profiles")
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
    .from("group_profiles")
    .delete()
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function countTrilhaPerfisUsage(nome, client) {
  const { count, error } = await getClient(client)
    .from("trilha_perfis")
    .select("id", { count: "exact", head: true })
    .eq("perfil", nome);

  if (error) {
    throw error;
  }

  return count || 0;
}

async function countGroupsUsage(nome, client) {
  const { count, error } = await getClient(client)
    .from("groups")
    .select("id", { count: "exact", head: true })
    .eq("segmento", nome);

  if (error) {
    throw error;
  }

  return count || 0;
}

module.exports = {
  countGroupsUsage,
  countTrilhaPerfisUsage,
  create,
  delete: remove,
  findAll,
  remove,
};
