const defaultSupabaseClient = require("../database/client");

function getClient(client = defaultSupabaseClient) {
  return client;
}

async function registerDelivery(payload, client = defaultSupabaseClient) {
  const { data, error } = await getClient(client)
    .from("group_video_progress")
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function listDelivered(groupId, client = defaultSupabaseClient) {
  const { data, error } = await getClient(client)
    .from("group_video_progress")
    .select("*")
    .eq("group_id", groupId)
    .order("enviado_em", { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function getLastVideo(groupId, client = defaultSupabaseClient) {
  const { data, error } = await getClient(client)
    .from("group_video_progress")
    .select("*")
    .eq("group_id", groupId)
    .order("enviado_em", { ascending: false })
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function hasDuplicate(groupId, videoId, client = defaultSupabaseClient) {
  const { data, error } = await getClient(client)
    .from("group_video_progress")
    .select("id")
    .eq("group_id", groupId)
    .eq("video_id", videoId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return Boolean(data);
}

module.exports = {
  getLastVideo,
  hasDuplicate,
  listDelivered,
  registerDelivery,
};
