function getClient(client) {
  return client || require("../database/client");
}

async function registerDelivery(payload, client) {
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

// Usado quando a regra "nunca repetir video" esta desativada: o par (group_id,
// video_id) e UNIQUE no banco, entao um reenvio forcado precisa atualizar
// enviado_em na linha existente em vez de tentar inserir uma duplicata.
async function upsertDelivery(payload, client) {
  const { data, error } = await getClient(client)
    .from("group_video_progress")
    .upsert(
      { ...payload, enviado_em: payload.enviado_em || new Date().toISOString() },
      { onConflict: "group_id,video_id" }
    )
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function listDelivered(groupId, client) {
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

async function listDeliveredWithVideo(groupId, client) {
  const { data, error } = await getClient(client)
    .from("group_video_progress")
    .select("*, video_catalog(*)")
    .eq("group_id", groupId)
    .order("enviado_em", { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function getLastVideo(groupId, client) {
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

// "Ja recebeu" para o motor de sequenciamento automatico (desvios por setor devem
// ser entregues no maximo uma vez na vida do grupo): so conta entrega real
// (enviado_em preenchido), nunca a mera atribuicao de trilha_id sem video enviado -
// caso contrario um desvio com zero videos aprovados no momento queimaria a unica
// chance do grupo sem entregar nada.
async function hasGroupReceivedTrilha(groupId, trilhaId, client) {
  const { data, error } = await getClient(client)
    .from("group_video_progress")
    .select("id")
    .eq("group_id", groupId)
    .eq("trilha_id", trilhaId)
    .not("enviado_em", "is", null)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return Boolean(data);
}

async function hasDuplicate(groupId, videoId, client) {
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
  hasGroupReceivedTrilha,
  listDelivered,
  listDeliveredWithVideo,
  registerDelivery,
  upsertDelivery,
};
