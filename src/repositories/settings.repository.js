function getClient(client) {
  return client || require("../database/client");
}

async function getSettings(client) {
  const { data, error } = await getClient(client)
    .from("settings")
    .select("*")
    .eq("key", "global")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function updateSettings(payload, client) {
  const { data, error } = await getClient(client)
    .from("settings")
    .update(payload)
    .eq("key", "global")
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

module.exports = {
  getSettings,
  updateSettings,
};
