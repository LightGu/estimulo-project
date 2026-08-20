function getClient(client) {
  return client || require("../database/client");
}

const NOTIFICATIONS_TABLE = "notifications";

async function create(payload, client) {
  const { data, error } = await getClient(client)
    .from(NOTIFICATIONS_TABLE)
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function listRecent(limit = 20, client) {
  const { data, error } = await getClient(client)
    .from(NOTIFICATIONS_TABLE)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return data || [];
}

async function countUnread(client) {
  const { count, error } = await getClient(client)
    .from(NOTIFICATIONS_TABLE)
    .select("id", { count: "exact", head: true })
    .is("read_at", null);

  if (error) {
    throw error;
  }

  return count || 0;
}

async function markAllRead(readAt, client) {
  const { error } = await getClient(client)
    .from(NOTIFICATIONS_TABLE)
    .update({ read_at: readAt })
    .is("read_at", null);

  if (error) {
    throw error;
  }

  return true;
}

async function markRead(id, readAt, client) {
  const { data, error } = await getClient(client)
    .from(NOTIFICATIONS_TABLE)
    .update({ read_at: readAt })
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function deleteRead(client) {
  const { error } = await getClient(client)
    .from(NOTIFICATIONS_TABLE)
    .delete()
    .not("read_at", "is", null);

  if (error) {
    throw error;
  }

  return true;
}

module.exports = {
  countUnread,
  create,
  deleteRead,
  listRecent,
  markAllRead,
  markRead,
};
