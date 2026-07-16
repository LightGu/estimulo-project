function getClient(client) {
  return client || require("../database/client");
}

async function listGroups(campaignId, client) {
  const { data, error } = await getClient(client)
    .from("campaign_groups")
    .select("*, groups(*)")
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function associateGroup(campaignId, groupId, client) {
  const { data, error } = await getClient(client)
    .from("campaign_groups")
    .insert({ campaign_id: campaignId, group_id: groupId })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function removeGroup(campaignId, groupId, client) {
  const { data, error } = await getClient(client)
    .from("campaign_groups")
    .delete()
    .eq("campaign_id", campaignId)
    .eq("group_id", groupId)
    .select("*")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

module.exports = {
  associateGroup,
  listGroups,
  removeGroup,
};
