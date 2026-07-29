function getClient(client) {
  return client || require("../database/client");
}

async function findAll(client) {
  const { data, error } = await getClient(client)
    .from("whatsapp_instances")
    .select("*")
    .order("priority", { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

async function listActive(client) {
  const { data, error } = await getClient(client)
    .from("whatsapp_instances")
    .select("*")
    .eq("active", true)
    .order("priority", { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

async function findById(id, client) {
  const { data, error } = await getClient(client)
    .from("whatsapp_instances")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function findByInstanceName(instanceName, client) {
  const { data, error } = await getClient(client)
    .from("whatsapp_instances")
    .select("*")
    .eq("instance_name", instanceName)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function create(payload, client) {
  const { data, error } = await getClient(client)
    .from("whatsapp_instances")
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
    .from("whatsapp_instances")
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
    .from("whatsapp_instances")
    .delete()
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

// Reescreve a prioridade de cada instancia conforme a ordem do array recebido
// (indice 0 = prioridade mais alta). Usado apos reordenar manualmente e apos
// remover uma instancia, para fechar o "buraco" deixado na sequencia.
async function reorderPriorities(orderedIds, client) {
  const db = getClient(client);

  await Promise.all(
    orderedIds.map((id, index) => db.from("whatsapp_instances").update({ priority: index }).eq("id", id))
  );

  return listActive(db);
}

module.exports = {
  create,
  delete: remove,
  findAll,
  findById,
  findByInstanceName,
  listActive,
  remove,
  reorderPriorities,
  update,
};
