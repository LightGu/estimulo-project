function getClient(client) {
  return client || require("../database/client");
}

async function createPending(payload, client) {
  const { data, error } = await getClient(client)
    .from("campaign_video_captions")
    .insert({
      campaign_id: payload.campaign_id,
      group_id: payload.group_id,
      video_id: payload.video_id,
      status: "processando",
    })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function findById(id, client) {
  const { data, error } = await getClient(client)
    .from("campaign_video_captions")
    .select("*, groups(nome, trilha_id, trilhas(macrotema, trilha)), video_catalog(nome_do_arquivo, drive_file_id)")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function markProcessing(id, client) {
  const { data, error } = await getClient(client)
    .from("campaign_video_captions")
    .update({
      status: "processando",
      erro_mensagem: null,
      atualizado_em: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function markGenerated(id, payload, client) {
  const { data, error } = await getClient(client)
    .from("campaign_video_captions")
    .update({
      status: "gerado",
      caption_id: payload.caption_id || null,
      caption_text: payload.caption_text,
      erro_mensagem: null,
      atualizado_em: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function markError(id, payload, client) {
  const { data, error } = await getClient(client)
    .from("campaign_video_captions")
    .update({
      status: "erro",
      erro_mensagem: payload.erro_mensagem,
      atualizado_em: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function updateCaptionText(id, payload, client) {
  const { data, error } = await getClient(client)
    .from("campaign_video_captions")
    .update({
      caption_text: payload.caption_text,
      status: "gerado",
      erro_mensagem: null,
      atualizado_em: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function listByCampaign(campaignId, client) {
  const { data, error } = await getClient(client)
    .from("campaign_video_captions")
    .select("*, groups(nome, trilha_id, trilhas(macrotema, trilha)), video_catalog(nome_do_arquivo, drive_file_id)")
    .eq("campaign_id", campaignId)
    .order("criado_em", { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

module.exports = {
  createPending,
  findById,
  listByCampaign,
  markError,
  markGenerated,
  markProcessing,
  updateCaptionText,
};
