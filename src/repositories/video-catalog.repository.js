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
    .order("created_at", { ascending: false });

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
    .order("created_at", { ascending: false });

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
    .order("created_at", { ascending: false });

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
  remove,
  update,
};
