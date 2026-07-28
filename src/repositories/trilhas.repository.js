function getClient(client) {
  return client || require("../database/client");
}

function normalizeComparableText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
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

async function findByMacrotemaTrilha(macrotema, trilha, client) {
  const { data, error } = await getClient(client)
    .from("trilhas")
    .select("*")
    .eq("macrotema", macrotema)
    .eq("trilha", trilha)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function listAll(client) {
  const { data, error } = await getClient(client)
    .from("trilhas")
    .select("*")
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

async function findByTrilhaName(trilha, client) {
  const { data, error } = await getClient(client)
    .from("trilhas")
    .select("*")
    .eq("trilha", trilha)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

// Resolve o proximo video aprovado de uma trilha para um perfil via os vinculos
// relacionais (trilha_perfis + trilha_videos), substituindo a comparacao textual de
// video-catalog.repository.js::findFirstApprovedByProfileAndTrail para grupos ja
// migrados para trilha_id.
async function findFirstApprovedVideoByTrilhaAndProfile(trilhaId, perfil, client) {
  const resolvedClient = getClient(client);

  const perfis = await listTrailPerfis(trilhaId, resolvedClient);
  const normalizedPerfil = normalizeComparableText(perfil);
  const hasMatchingPerfil = perfis.some((row) => normalizeComparableText(row.perfil) === normalizedPerfil);

  if (!hasMatchingPerfil) {
    return null;
  }

  const links = await listVideoLinksByTrilha(trilhaId, resolvedClient);

  if (!links.length) {
    return null;
  }

  const videoIds = links.map((link) => link.video_id);
  const { data: videos, error: videosError } = await resolvedClient
    .from("video_catalog")
    .select("*")
    .in("id", videoIds)
    .eq("status", true);

  if (videosError) {
    throw videosError;
  }

  const approvedVideoById = new Map((videos || []).map((video) => [video.id, video]));
  const firstApprovedLink = links.find((link) => approvedVideoById.has(link.video_id));

  if (!firstApprovedLink) {
    return null;
  }

  return { ...approvedVideoById.get(firstApprovedLink.video_id), ordem: firstApprovedLink.ordem };
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

async function listAllTrailPerfis(client) {
  const { data, error } = await getClient(client).from("trilha_perfis").select("*");

  if (error) {
    throw error;
  }

  return data || [];
}

async function listTrilhasByPerfil(perfil, client) {
  const resolvedClient = getClient(client);

  const { data: perfilRows, error: perfilError } = await resolvedClient
    .from("trilha_perfis")
    .select("trilha_id")
    .eq("perfil", perfil);

  if (perfilError) {
    throw perfilError;
  }

  const trilhaIds = [...new Set((perfilRows || []).map((row) => row.trilha_id))];

  if (!trilhaIds.length) {
    return [];
  }

  const { data: trilhas, error: trilhasError } = await resolvedClient
    .from("trilhas")
    .select("*")
    .in("id", trilhaIds)
    .order("macrotema", { ascending: true })
    .order("trilha", { ascending: true });

  if (trilhasError) {
    throw trilhasError;
  }

  return trilhas || [];
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
  findByMacrotemaTrilha,
  findByTrilhaName,
  findFirstApprovedVideoByTrilhaAndProfile,
  findVideoLink,
  listAll,
  listAllTrailPerfis,
  listAllVideoLinks,
  listTrailPerfis,
  listTrilhasByPerfil,
  listTrilhasForVideo,
  listVideoLinksByTrilha,
  remove,
  removeVideo,
  rename,
  reorderVideosWithinTrilha,
  setTrailPerfis,
};
