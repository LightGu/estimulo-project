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

async function listTrilhasByProfileId(profileId, client) {
  const resolvedClient = getClient(client);

  const { data: perfilRows, error: perfilError } = await resolvedClient
    .from("trilha_perfis")
    .select("trilha_id")
    .eq("profile_id", profileId);

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

// Sequencia ordenada de trilha_perfis para um perfil - usada pelo motor de
// sequenciamento automatico (precisa so de trilha_id+ordem) e pela tela
// administrativa "Ordem por perfil" (que enriquece com dados de exibicao por
// cima, via listTrilhasByProfileId + buildOverview em trilhas.service.js).
async function listTrilhaPerfisByProfile(profileId, client) {
  const { data, error } = await getClient(client)
    .from("trilha_perfis")
    .select("*")
    .eq("profile_id", profileId)
    .order("ordem", { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

// Insere uma trilha ja existente ao final da sequencia de um perfil (usada pelo
// botao "+ Adicionar trilha" da aba "Ordem por perfil"). trilha_perfis.ordem e
// NOT NULL (migration 202607310006), entao precisa ser calculado aqui - ao
// contrario de setTrailPerfis, que grava sem ordem por ser chamada so pelo fluxo
// de checkboxes do Catalogo.
async function addTrilhaToProfileSequence(trilhaId, profileId, perfilNome, client) {
  const resolvedClient = getClient(client);

  const existing = await listTrilhaPerfisByProfile(profileId, resolvedClient);
  const maxOrdem = existing.reduce((max, row) => Math.max(max, Number(row.ordem) || 0), 0);

  const { data, error } = await resolvedClient
    .from("trilha_perfis")
    .insert({
      trilha_id: trilhaId,
      profile_id: profileId,
      perfil: perfilNome,
      ordem: maxOrdem + 1,
    })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

// Remove uma trilha da sequencia de um perfil (usada pelo botao "Remover" da
// aba "Ordem por perfil"). Nao renumera as ordens restantes: ha gaps depois da
// remocao, mas o ORDER BY ordem da listTrilhaPerfisByProfile continua correto.
async function removeTrilhaFromProfileSequence(trilhaId, profileId, client) {
  const { data, error } = await getClient(client)
    .from("trilha_perfis")
    .delete()
    .eq("trilha_id", trilhaId)
    .eq("profile_id", profileId)
    .select("*")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

// Mesmo padrao de reorderVideosWithinTrilha (trilha_videos.ordem): uma escrita por
// linha, sem transacao explicita - nao ha unique constraint em (profile_id, ordem)
// de proposito (ver migration 202607310006), entao nao existe estado intermediario
// invalido a proteger.
async function reorderTrilhaPerfisForProfile(profileId, orderedTrilhaIds, client) {
  const resolvedClient = getClient(client);
  const updates = orderedTrilhaIds.map((trilhaId, index) =>
    resolvedClient
      .from("trilha_perfis")
      .update({ ordem: index + 1 })
      .eq("profile_id", profileId)
      .eq("trilha_id", trilhaId)
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

async function setTrailPerfis(trilhaId, perfis, client) {
  const resolvedClient = getClient(client);

  // Resolve profile_id pelo nome: sem isso a linha fica so com o texto legado
  // `perfil` e se torna invisivel para listTrilhasByProfileId/o motor de
  // sequenciamento, que consultam por profile_id (ver migration
  // 202607310004_backfill_trilha_perfis_profile_id.sql).
  const { data: profiles, error: profilesError } = await resolvedClient
    .from("group_profiles")
    .select("id, nome")
    .in("nome", perfis.length ? perfis : [""]);

  if (profilesError) {
    throw profilesError;
  }

  const profileIdByNome = new Map((profiles || []).map((profile) => [profile.nome, profile.id]));

  // trilha_perfis.ordem e NOT NULL (migration 202607310006) - calcula o proximo
  // ordem de cada perfil antes de apagar a linha atual desta trilha, para nao
  // deixar a trilha "orfa" de sequencia se o insert falhar por perfil sem ordem.
  const ordemByProfileId = new Map();

  for (const perfil of perfis) {
    const profileId = profileIdByNome.get(perfil);

    if (!profileId || ordemByProfileId.has(profileId)) {
      continue;
    }

    const existingSequence = await listTrilhaPerfisByProfile(profileId, resolvedClient);
    const maxOrdem = existingSequence
      .filter((row) => row.trilha_id !== trilhaId)
      .reduce((max, row) => Math.max(max, Number(row.ordem) || 0), 0);
    ordemByProfileId.set(profileId, maxOrdem);
  }

  const { error: deleteError } = await resolvedClient.from("trilha_perfis").delete().eq("trilha_id", trilhaId);

  if (deleteError) {
    throw deleteError;
  }

  if (!perfis.length) {
    return [];
  }

  const { data, error: insertError } = await resolvedClient
    .from("trilha_perfis")
    .insert(
      perfis.map((perfil) => {
        const profileId = profileIdByNome.get(perfil) || null;
        const ordem = profileId ? ordemByProfileId.get(profileId) + 1 : 1;

        return {
          trilha_id: trilhaId,
          perfil,
          profile_id: profileId,
          ordem,
        };
      })
    )
    .select("*");

  if (insertError) {
    throw insertError;
  }

  return data || [];
}

module.exports = {
  addTrilhaToProfileSequence,
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
  listTrilhaPerfisByProfile,
  listTrilhasByPerfil,
  listTrilhasByProfileId,
  reorderTrilhaPerfisForProfile,
  removeTrilhaFromProfileSequence,
  listVideoLinksByTrilha,
  remove,
  removeVideo,
  rename,
  reorderVideosWithinTrilha,
  setTrailPerfis,
};
