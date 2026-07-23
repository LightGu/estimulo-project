function getClient(client) {
  return client || require("../database/client");
}

function normalizeComparableText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

async function findById(id, client) {
  const { data, error } = await getClient(client)
    .from("video_catalog")
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
    .from("video_catalog")
    .select("*")
    .order("ordem_geral", { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function listApproved(client) {
  const { data, error } = await getClient(client)
    .from("video_catalog")
    .select("*")
    .eq("status", true);

  if (error) {
    throw error;
  }

  return data || [];
}

async function listTrailsByProfile(profile, client) {
  const videos = await listApproved(client);
  const normalizedProfile = normalizeComparableText(profile);
  const trailsByName = new Map();

  videos
    .filter((video) => normalizeComparableText(video.perfil_da_jornada || video.trilha_segmento) === normalizedProfile)
    .forEach((video) => {
      if (!video.trilha) {
        return;
      }

      const current = trailsByName.get(video.trilha) || {
        perfil_da_jornada: video.perfil_da_jornada,
        trilha: video.trilha,
        videos_count: 0,
        first_video: null,
      };

      current.videos_count += 1;
      trailsByName.set(video.trilha, current);
    });

  const trails = Array.from(trailsByName.values()).sort((left, right) => left.trilha.localeCompare(right.trilha));

  for (const trail of trails) {
    trail.first_video = await findFirstApprovedByProfileAndTrail(
      trail.perfil_da_jornada || profile,
      trail.trilha,
      client
    );
  }

  return trails;
}

async function findFirstApprovedByProfileAndTrail(profile, trail, client) {
  const videos = await listApproved(client);
  const normalizedProfile = normalizeComparableText(profile);
  const normalizedTrail = normalizeComparableText(trail);

  return videos
    .filter((video) => normalizeComparableText(video.perfil_da_jornada || video.trilha_segmento) === normalizedProfile)
    .filter((video) => normalizeComparableText(video.trilha || video.trilha_segmento) === normalizedTrail)
    .sort((left, right) => {
      const leftOrder = Number(left.ordem_geral || left.ordem || left.etapa || Number.MAX_SAFE_INTEGER);
      const rightOrder = Number(right.ordem_geral || right.ordem || right.etapa || Number.MAX_SAFE_INTEGER);

      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }

      return String(left.nome_do_arquivo || left.nome || "").localeCompare(String(right.nome_do_arquivo || right.nome || ""));
    })[0] || null;
}

async function listTrailsOverview(client) {
  const { data, error } = await getClient(client)
    .from("video_catalog")
    .select("*")
    .order("ordem_geral", { ascending: true });

  if (error) {
    throw error;
  }

  const videos = data || [];
  const trailsByKey = new Map();

  videos.forEach((video) => {
    const perfil = video.perfil_da_jornada || video.trilha_segmento || "Sem perfil";
    const macrotema = video.macrotema || "Sem macrotema";
    const trilha = video.trilha || video.trilha_segmento || "Sem trilha";
    const key = `${perfil}␟${macrotema}␟${trilha}`;

    if (!trailsByKey.has(key)) {
      trailsByKey.set(key, {
        perfil_da_jornada: perfil,
        macrotema,
        trilha,
        videos: [],
      });
    }

    trailsByKey.get(key).videos.push(video);
  });

  return Array.from(trailsByKey.values()).sort((left, right) => {
    if (left.perfil_da_jornada !== right.perfil_da_jornada) {
      return left.perfil_da_jornada.localeCompare(right.perfil_da_jornada);
    }

    if (left.macrotema !== right.macrotema) {
      return left.macrotema.localeCompare(right.macrotema);
    }

    return left.trilha.localeCompare(right.trilha);
  });
}

async function listUnclassified(client) {
  const { data, error } = await getClient(client)
    .from("video_catalog")
    .select("*")
    .or("trilha.is.null,macrotema.is.null,perfil_da_jornada.is.null")
    .order("nome_do_arquivo", { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

async function listBySegmento(trilhaSegmento, client) {
  const { data, error } = await getClient(client)
    .from("video_catalog")
    .select("*")
    .eq("trilha_segmento", trilhaSegmento)
    .order("etapa", { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

async function listByEtapa(etapa, client) {
  const { data, error } = await getClient(client)
    .from("video_catalog")
    .select("*")
    .eq("etapa", etapa)
    .order("ordem_geral", { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function listByStatus(status, client) {
  const { data, error } = await getClient(client)
    .from("video_catalog")
    .select("*")
    .eq("status", status)
    .order("ordem_geral", { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function findByDriveFileId(driveFileId, client) {
  const { data, error } = await getClient(client)
    .from("video_catalog")
    .select("*")
    .eq("drive_file_id", driveFileId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function reorderWithinTrail(orderedIds, client) {
  const resolvedClient = getClient(client);
  const updates = orderedIds.map((id, index) =>
    resolvedClient
      .from("video_catalog")
      .update({ ordem: index + 1 })
      .eq("id", id)
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

async function create(payload, client) {
  const { data, error } = await getClient(client)
    .from("video_catalog")
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
    .from("video_catalog")
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
    .from("video_catalog")
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
  findByDriveFileId,
  findById,
  findFirstApprovedByProfileAndTrail,
  listApproved,
  listByEtapa,
  listBySegmento,
  listByStatus,
  listTrailsByProfile,
  listTrailsOverview,
  listUnclassified,
  remove,
  reorderWithinTrail,
  update,
};
