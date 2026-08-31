function getClient(client) {
  return client || require("../database/client");
}

// Idempotente: registra (ou atualiza o last_seen_at de) o vinculo grupo<->instancia
// descoberto em uma passada de sincronizacao.
async function linkGroupToInstance(groupId, whatsappInstanceId, client) {
  const { data, error } = await getClient(client)
    .from("group_whatsapp_instances")
    .upsert(
      {
        group_id: groupId,
        whatsapp_instance_id: whatsappInstanceId,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: "group_id,whatsapp_instance_id" }
    )
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

// Remove vinculos de uma instancia para grupos que nao apareceram na ultima
// passada de sincronizacao (ela deixou de ser membro daquele grupo).
async function unlinkGroupsNotIn(whatsappInstanceId, groupIdsStillPresent, client) {
  const db = getClient(client);
  let query = db.from("group_whatsapp_instances").delete().eq("whatsapp_instance_id", whatsappInstanceId);

  if (groupIdsStillPresent.length > 0) {
    query = query.not("group_id", "in", `(${groupIdsStillPresent.map((id) => `"${id}"`).join(",")})`);
  }

  const { error } = await query;

  if (error) {
    throw error;
  }
}

async function listGroupIdsForInstance(whatsappInstanceId, client) {
  const { data, error } = await getClient(client)
    .from("group_whatsapp_instances")
    .select("group_id")
    .eq("whatsapp_instance_id", whatsappInstanceId);

  if (error) {
    throw error;
  }

  return (data || []).map((row) => row.group_id);
}

// Retorna os group_ids vinculados a QUALQUER uma das instancias informadas, em
// uma unica query. Usado ao remover um numero para descobrir quais grupos ainda
// tem cobertura pelos numeros restantes.
async function listGroupIdsForInstances(whatsappInstanceIds, client) {
  if (!whatsappInstanceIds || whatsappInstanceIds.length === 0) {
    return [];
  }

  const { data, error } = await getClient(client)
    .from("group_whatsapp_instances")
    .select("group_id")
    .in("whatsapp_instance_id", whatsappInstanceIds);

  if (error) {
    throw error;
  }

  return [...new Set((data || []).map((row) => row.group_id))];
}

// Retorna, para uma lista de grupos, o conjunto de instancias vinculadas a cada um
// (Map<group_id, Set<whatsapp_instance_id>>), em uma unica query.
async function listInstanceIdsByGroupIds(groupIds, client) {
  if (!groupIds || groupIds.length === 0) {
    return new Map();
  }

  const { data, error } = await getClient(client)
    .from("group_whatsapp_instances")
    .select("group_id, whatsapp_instance_id")
    .in("group_id", groupIds);

  if (error) {
    throw error;
  }

  const map = new Map();

  (data || []).forEach((row) => {
    if (!map.has(row.group_id)) {
      map.set(row.group_id, new Set());
    }

    map.get(row.group_id).add(row.whatsapp_instance_id);
  });

  return map;
}

module.exports = {
  linkGroupToInstance,
  listGroupIdsForInstance,
  listGroupIdsForInstances,
  listInstanceIdsByGroupIds,
  unlinkGroupsNotIn,
};
