function getClient(client) {
  return client || require("../database/client");
}

async function findById(id, client) {
  const { data, error } = await getClient(client)
    .from("trilhas")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function findByOrganizationMacrotemaTrilha(organizationId, macrotema, trilha, client) {
  const { data, error } = await getClient(client)
    .from("trilhas")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("macrotema", macrotema)
    .eq("trilha", trilha)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function listByOrganization(organizationId, client) {
  const { data, error } = await getClient(client)
    .from("trilhas")
    .select("*")
    .eq("organization_id", organizationId)
    .order("macrotema", { ascending: true })
    .order("trilha", { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

async function create(payload, client) {
  const { data, error } = await getClient(client)
    .from("trilhas")
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function rename(id, payload, client) {
  const { data, error } = await getClient(client)
    .from("trilhas")
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
    .from("trilhas")
    .delete()
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function listVideoLinksByTrilha(trilhaId, client) {
  const { data, error } = await getClient(client)
    .from("trilha_videos")
    .select("*")
    .eq("trilha_id", trilhaId)
    .order("ordem", { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

async function listVideoLinksByOrganization(organizationId, client) {
  const trilhas = await listByOrganization(organizationId, client);
  const trilhaIds = trilhas.map((trilha) => trilha.id);

  if (!trilhaIds.length) {
    return [];
  }

  const { data, error } = await getClient(client)
    .from("trilha_videos")
    .select("*")
    .in("trilha_id", trilhaIds)
    .order("ordem", { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

async function addVideo(trilhaId, videoId, ordem, client) {
  const { data, error } = await getClient(client)
    .from("trilha_videos")
    .insert({ trilha_id: trilhaId, video_id: videoId, ordem })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function removeVideo(trilhaId, videoId, client) {
  const { data, error } = await getClient(client)
    .from("trilha_videos")
    .delete()
    .eq("trilha_id", trilhaId)
    .eq("video_id", videoId)
    .select("*")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function findVideoLink(trilhaId, videoId, client) {
  const { data, error } = await getClient(client)
    .from("trilha_videos")
    .select("*")
    .eq("trilha_id", trilhaId)
    .eq("video_id", videoId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function listTrilhasForVideo(videoId, client) {
  const { data, error } = await getClient(client)
    .from("trilha_videos")
    .select("*")
    .eq("video_id", videoId);

  if (error) {
    throw error;
  }

  return data || [];
}

async function reorderVideosWithinTrilha(trilhaId, orderedVideoIds, client) {
  const resolvedClient = getClient(client);
  const updates = orderedVideoIds.map((videoId, index) =>
    resolvedClient
      .from("trilha_videos")
      .update({ ordem: index + 1 })
      .eq("trilha_id", trilhaId)
      .eq("video_id", videoId)
      .select("*")
      .single()
  );

  const results = await Promise.all(updates);
  const failed = results.find((result) => result.error);

  if (failed) {
    throw failed.error;
  }

  return results.map((result) => result.data);
}

async function listAllVideoLinks(client) {
  const { data, error } = await getClient(client).from("trilha_videos").select("*");

  if (error) {
    throw error;
  }

  return data || [];
}

async function listTrailPerfis(trilhaId, client) {
  const { data, error } = await getClient(client)
    .from("trilha_perfis")
    .select("*")
    .eq("trilha_id", trilhaId);

  if (error) {
    throw error;
  }

  return data || [];
}

async function listTrailPerfisByOrganization(organizationId, client) {
  const trilhas = await listByOrganization(organizationId, client);
  const trilhaIds = trilhas.map((trilha) => trilha.id);

  if (!trilhaIds.length) {
    return [];
  }

  const { data, error } = await getClient(client)
    .from("trilha_perfis")
    .select("*")
    .in("trilha_id", trilhaIds);

  if (error) {
    throw error;
  }

  return data || [];
}

async function setTrailPerfis(trilhaId, perfis, client) {
  const resolvedClient = getClient(client);

  const { error: deleteError } = await resolvedClient.from("trilha_perfis").delete().eq("trilha_id", trilhaId);

  if (deleteError) {
    throw deleteError;
  }

  if (!perfis.length) {
    return [];
  }

  const { data, error: insertError } = await resolvedClient
    .from("trilha_perfis")
    .insert(perfis.map((perfil) => ({ trilha_id: trilhaId, perfil })))
    .select("*");

  if (insertError) {
    throw insertError;
  }

  return data || [];
}

module.exports = {
  addVideo,
  create,
  delete: remove,
  findById,
  findByOrganizationMacrotemaTrilha,
  findVideoLink,
  listAllVideoLinks,
  listByOrganization,
  listTrailPerfis,
  listTrailPerfisByOrganization,
  listTrilhasForVideo,
  listVideoLinksByOrganization,
  listVideoLinksByTrilha,
  remove,
  removeVideo,
  rename,
  reorderVideosWithinTrilha,
  setTrailPerfis,
};
