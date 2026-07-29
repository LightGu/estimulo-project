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

async function findAllDriveFileIds(client) {
  const { data, error } = await getClient(client)
    .from("video_catalog")
    .select("id, drive_file_id")
    .not("drive_file_id", "is", null);

  if (error) {
    throw error;
  }

  return data || [];
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
  findAllDriveFileIds,
  findByDriveFileId,
  findById,
  listApproved,
  listByStatus,
  remove,
  update,
};
