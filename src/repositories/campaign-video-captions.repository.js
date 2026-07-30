function getClient(client) {
  return client || require("../database/client");
}

// Nasce como "pendente" (na fila). Quem marca "processando" e o servico, no
// instante em que a geracao daquele video comeca de fato - a fila e sequencial.
async function createPending(payload, client) {
  const { data, error } = await getClient(client)
    .from("campaign_video_captions")
    .insert({
      campaign_id: payload.campaign_id,
      group_id: payload.group_id,
      video_id: payload.video_id,
      status: "pendente",
    })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

// Cria todas as linhas da campanha de uma vez: a tela da Etapa 2 usa a contagem
// de linhas como total esperado, entao elas precisam aparecer juntas em vez de
// ir surgindo conforme cada legenda e gerada. Upsert (e nao insert) porque
// (campaign_id, group_id, video_id) e UNIQUE: numa segunda rodada de geracao para
// a mesma campanha, um insert em lote falharia inteiro por causa de uma linha
// repetida - aqui a linha existente volta para a fila e e regerada.
//
// Todas nascem em "pendente", nunca em "processando": a geracao percorre os
// videos um por um e marcar o lote inteiro como "processando" na criacao fazia a
// tela sugerir que havia uma requisicao de legenda por video em paralelo.
async function createManyPending(payloads, client) {
  if (!Array.isArray(payloads) || payloads.length === 0) {
    return [];
  }

  const { data, error } = await getClient(client)
    .from("campaign_video_captions")
    .upsert(
      payloads.map((payload) => ({
        campaign_id: payload.campaign_id,
        group_id: payload.group_id,
        video_id: payload.video_id,
        status: "pendente",
        erro_mensagem: null,
      })),
      { onConflict: "campaign_id,group_id,video_id" }
    )
    .select("*");

  if (error) {
    throw error;
  }

  return data || [];
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
  createManyPending,
  createPending,
  findById,
  listByCampaign,
  markError,
  markGenerated,
  markProcessing,
  updateCaptionText,
};
