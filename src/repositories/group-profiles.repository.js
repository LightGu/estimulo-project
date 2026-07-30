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

async function update(id, payload, client) {
  const { data, error } = await getClient(client)
    .from("group_profiles")
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

async function countTrilhaPerfisUsage(profileId, client) {
  const { count, error } = await getClient(client)
    .from("trilha_perfis")
    .select("id", { count: "exact", head: true })
    .eq("profile_id", profileId);

  if (error) {
    throw error;
  }

  return count || 0;
}

async function countGroupsUsage(profileId, client) {
  const { count, error } = await getClient(client)
    .from("groups")
    .select("id", { count: "exact", head: true })
    .eq("profile_id", profileId);

  if (error) {
    throw error;
  }

  return count || 0;
}

async function findTrilhaIdsByProfile(profileId, client) {
  const { data, error } = await getClient(client)
    .from("trilha_perfis")
    .select("trilha_id")
    .eq("profile_id", profileId);

  if (error) {
    throw error;
  }

  return (data || []).map((row) => row.trilha_id);
}

async function findGroupIdsByProfile(profileId, client) {
  const { data, error } = await getClient(client).from("groups").select("id").eq("profile_id", profileId);

  if (error) {
    throw error;
  }

  return (data || []).map((row) => row.id);
}

async function reassignTrilhaPerfis(fromProfileId, toProfileId, client) {
  const resolvedClient = getClient(client);

  const { data: targetRows, error: targetError } = await resolvedClient
    .from("trilha_perfis")
    .select("trilha_id")
    .eq("profile_id", toProfileId);

  if (targetError) {
    throw targetError;
  }

  const trilhaIdsWithTarget = (targetRows || []).map((row) => row.trilha_id);

  if (trilhaIdsWithTarget.length) {
    const { error: deleteError } = await resolvedClient
      .from("trilha_perfis")
      .delete()
      .eq("profile_id", fromProfileId)
      .in("trilha_id", trilhaIdsWithTarget);

    if (deleteError) {
      throw deleteError;
    }
  }

  const { error: updateError } = await resolvedClient
    .from("trilha_perfis")
    .update({ profile_id: toProfileId })
    .eq("profile_id", fromProfileId);

  if (updateError) {
    throw updateError;
  }
}

async function reassignGroupsProfile(fromProfileId, toProfileId, client) {
  const { error } = await getClient(client)
    .from("groups")
    .update({ profile_id: toProfileId })
    .eq("profile_id", fromProfileId);

  if (error) {
    throw error;
  }
}

async function reassignTrilhaPerfisByTrilhaIds(fromProfileId, toProfileId, trilhaIds, client) {
  if (!Array.isArray(trilhaIds) || !trilhaIds.length) {
    return;
  }

  const { error } = await getClient(client)
    .from("trilha_perfis")
    .update({ profile_id: toProfileId })
    .eq("profile_id", fromProfileId)
    .in("trilha_id", trilhaIds);

  if (error) {
    throw error;
  }
}

async function reassignGroupsProfileByIds(fromProfileId, toProfileId, groupIds, client) {
  if (!Array.isArray(groupIds) || !groupIds.length) {
    return;
  }

  const { error } = await getClient(client)
    .from("groups")
    .update({ profile_id: toProfileId })
    .eq("profile_id", fromProfileId)
    .in("id", groupIds);

  if (error) {
    throw error;
  }
}

// Usado na desfusao para recriar os vinculos trilha_perfis que a fusao colapsou
// (quando as duas trilhas tinham o mesmo perfil, a linha duplicada foi deletada).
async function insertTrilhaPerfis(rows, client) {
  if (!Array.isArray(rows) || !rows.length) {
    return;
  }

  const { error } = await getClient(client).from("trilha_perfis").insert(rows);

  if (error) {
    throw error;
  }
}

// A desfusao recria o perfil descartado preservando o id original, para que
// qualquer referencia externa remanescente volte a resolver.
async function createWithId(payload, client) {
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

async function createMergeRecord(payload, client) {
  const { data, error } = await getClient(client)
    .from("group_profile_merges")
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function findAllMergeRecords(client) {
  const { data, error } = await getClient(client)
    .from("group_profile_merges")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

// A fusao mais recente do sobrevivente e a primeira a ser desfeita (LIFO), para que
// fusoes encadeadas revertam na ordem inversa em que foram aplicadas.
async function findLatestMergeBySurvivorId(survivorId, client) {
  const { data, error } = await getClient(client)
    .from("group_profile_merges")
    .select("*")
    .eq("survivor_id", survivorId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function removeMergeRecord(id, client) {
  const { error } = await getClient(client).from("group_profile_merges").delete().eq("id", id);

  if (error) {
    throw error;
  }
}

module.exports = {
  countGroupsUsage,
  countTrilhaPerfisUsage,
  create,
  createMergeRecord,
  createWithId,
  delete: remove,
  findAll,
  findAllMergeRecords,
  findGroupIdsByProfile,
  findLatestMergeBySurvivorId,
  findTrilhaIdsByProfile,
  insertTrilhaPerfis,
  reassignGroupsProfile,
  reassignGroupsProfileByIds,
  reassignTrilhaPerfis,
  reassignTrilhaPerfisByTrilhaIds,
  remove,
  removeMergeRecord,
  update,
};
