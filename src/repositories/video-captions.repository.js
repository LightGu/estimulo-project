function getClient(client) {
  return client || require("../database/client");
}

async function listUnusedTodayByVideo(videoId, todayStart, client) {
  const { data, error } = await getClient(client)
    .from("video_captions")
    .select("*")
    .eq("video_id", videoId)
    .or(`ultimo_uso_em.is.null,ultimo_uso_em.lt.${todayStart.toISOString()}`)
    .order("ultimo_uso_em", { ascending: true, nullsFirst: true })
    .order("criado_em", { ascending: true })
    .limit(1);

  if (error) {
    throw error;
  }

  return data || [];
}

async function markUsed(id, usedAt = new Date(), client) {
  const { data, error } = await getClient(client)
    .from("video_captions")
    .update({ ultimo_uso_em: usedAt.toISOString() })
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function create(payload, client) {
  const { data, error } = await getClient(client)
    .from("video_captions")
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

module.exports = {
  create,
  listUnusedTodayByVideo,
  markUsed,
};
