function getClient(client) {
  return client || require("../database/client");
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
    .eq("status", true)
    .order("etapa", { ascending: true });

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
  listApproved,
  listByEtapa,
  listBySegmento,
  listByStatus,
  remove,
  update,
};
