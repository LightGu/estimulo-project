function getClient(client) {
  return client || require("../database/client");
}

const LOGS_TABLE = "logs";

// Espelham MAX_RETRY_ATTEMPTS do worker de retry; ficam aqui para que a query
// consiga filtrar/limitar sem depender da camada de queues.
const DEFAULT_MAX_RETRY_COUNT = 3;
const DEFAULT_FAILED_RETRY_BATCH_SIZE = 25;

// TEMPORARIO (investigacao 31/07/2026): registra a origem de todo log criado sem
// horario_envio_planejado - a assinatura das linhas que aparecem no relatorio com
// "-" e que nao correspondem a nenhum job nas filas. Inerte por padrao: so grava
// com TRACE_ORPHAN_DISPATCH_LOGS=1. Remover quando a causa estiver identificada.
// Confirma no stdout do worker que o rastreio subiu armado - sem isso nao da
// para distinguir "nenhum log orfao foi criado" de "o rastreio nem ligou".
if (process.env.TRACE_ORPHAN_DISPATCH_LOGS === "1") {
  console.log(
    JSON.stringify({
      event: "dispatch_logs.orphan_trace_armed",
      pid: process.pid,
      entrypoint: process.argv[1],
    })
  );
}

function traceOrphanLogCreation(payload) {
  if (process.env.TRACE_ORPHAN_DISPATCH_LOGS !== "1") {
    return;
  }

  if (payload && payload.horario_envio_planejado) {
    return;
  }

  // O rastreio nunca pode derrubar um envio: qualquer falha aqui e engolida.
  try {
    const fs = require("fs");
    const path = require("path");
    const file =
      process.env.TRACE_ORPHAN_DISPATCH_LOGS_FILE ||
      path.join(__dirname, "..", "..", "storage", "orphan-dispatch-logs.jsonl");

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      JSON.stringify({
        at: new Date().toISOString(),
        pid: process.pid,
        entrypoint: process.argv[1],
        payload,
        stack: new Error("log de dispatch criado sem horario planejado").stack,
      }) + "\n",
      "utf8"
    );
  } catch (error) {
    // Ignorado de proposito.
  }
}

async function createLog(payload, client) {
  traceOrphanLogCreation(payload);

  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function updateStatus(id, status, mensagemErro = null, client) {
  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .update({ status, mensagem_erro: mensagemErro })
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

// Grava a evidencia devolvida pela Evolution no log ja marcado como enviado.
// Separada de updateStatus para nao mexer na assinatura dela (o 4o parametro ja
// e o client). Quem chama trata como best-effort: perder a evidencia nao pode
// transformar uma mensagem entregue em job falhado.
async function updateProviderDelivery(id, delivery = {}, client) {
  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .update({
      provider_message_id: delivery.provider_message_id ?? null,
      provider_status: delivery.provider_status ?? null,
    })
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function updatePlannedSchedule(id, horarioEnvioPlanejado, client) {
  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .update({ horario_envio_planejado: horarioEnvioPlanejado })
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

// Usado pelo worker de "reprocessar falhas automaticamente": reaproveita o log
// falhou existente em vez de deixar dispatch-consistency criar um novo attempt
// log, evitando duplicar historico para o mesmo par campaign/group/video.
async function markRetrying(id, retryCount, client) {
  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .update({ status: "pendente", mensagem_erro: null, retry_count: retryCount })
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

// Usado por cancelCampaign: marca de uma vez todos os logs ainda pendentes
// como cancelado, para que nenhum deles seja disparado depois. Deliberadamente
// nao inclui "processando": esse envio pode ja estar nas maos da Evolution, e
// forcar o status por cima esconderia um "enviado"/"falhou" real. Logs
// enviado/falhou/erro ficam intactos - preservam o historico do que ja
// aconteceu antes do cancelamento.
async function cancelPendingByCampaign(campaignId, client) {
  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .update({ status: "cancelado" })
    .eq("campaign_id", campaignId)
    .eq("status", "pendente")
    .select("*");

  if (error) {
    throw error;
  }

  return data || [];
}

async function listPendingByCampaign(campaignId, client) {
  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .select("*")
    .eq("campaign_id", campaignId)
    .eq("status", "pendente");

  if (error) {
    throw error;
  }

  return data || [];
}

async function findById(id, client) {
  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

// Reivindicacao atomica do envio: so passa de pendente para processando se a
// linha ainda estiver pendente nesse instante. Substitui um updateStatus
// incondicional que deixava dois jobs em voo para o mesmo log (ex.: um job
// antigo que sobreviveu no Redis durante uma pausa e o job novo criado no
// resume) mandarem os dois - so quem vence o UPDATE segue para o envio, o
// outro recebe null e vira no-op.
async function claimForSend(id, client) {
  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .update({ status: "processando" })
    .eq("id", id)
    .eq("status", "pendente")
    .select("*")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

// Grava o id do job do BullMQ responsavel por este envio, para o resume
// conseguir localiza-lo direto (queue.getJob(id)) em vez de escanear a fila.
async function updateDispatchJobId(id, dispatchJobId, client) {
  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .update({ dispatch_job_id: dispatchJobId })
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
    .from(LOGS_TABLE)
    .select("*")
    .eq("campaign_id", campaignId)
    .order("criado_em", { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function listByGroup(groupId, client) {
  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .select("*")
    .eq("group_id", groupId)
    .order("criado_em", { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function listRecent(limit = 10, client) {
  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .select("*")
    .order("criado_em", { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return data || [];
}

async function listWithFilters(filters = {}, client) {
  let query = getClient(client)
    .from(LOGS_TABLE)
    .select(
      "*, campaigns(id, trilha, data_envio, horario_envio, tipo), groups(id, nome, organization_id, organizations(id, nome)), video_catalog(id, nome_do_arquivo)"
    )
    .order("criado_em", { ascending: false });

  if (filters.startDate) {
    query = query.gte("criado_em", filters.startDate);
  }

  if (filters.endDate) {
    query = query.lte("criado_em", filters.endDate);
  }

  if (filters.groupId) {
    query = query.eq("group_id", filters.groupId);
  }

  if (filters.status) {
    query = query.eq("status", filters.status);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return data || [];
}

// Usado pelo worker de "reprocessar falhas automaticamente": traz o suficiente
// de groups/video_catalog para remontar o job de dispatch (evolution_group_id,
// trilha_id, drive_file_id, link_video).
//
// O filtro por retry_count e o limite sao aplicados no banco (e nao apenas no
// processor) para que um backlog grande de falhas nao seja carregado inteiro a
// cada sweep e reenfileirado de uma vez — cada reenvio que falha gera uma
// notificacao no WhatsApp, entao a varredura precisa ser limitada na origem.
async function listFailedForRetry(options = {}, client) {
  const maxRetryCount = Number.isFinite(Number(options.max_retry_count))
    ? Number(options.max_retry_count)
    : DEFAULT_MAX_RETRY_COUNT;
  const limit = Number.isFinite(Number(options.limit))
    ? Number(options.limit)
    : DEFAULT_FAILED_RETRY_BATCH_SIZE;

  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .select(
      "*, groups(id, evolution_group_id, trilha_id), video_catalog(id, drive_file_id, link_video, nome_do_arquivo)"
    )
    .eq("status", "falhou")
    .lt("retry_count", maxRetryCount)
    .order("criado_em", { ascending: true })
    .limit(limit);

  if (error) {
    throw error;
  }

  return data || [];
}

module.exports = {
  DEFAULT_FAILED_RETRY_BATCH_SIZE,
  DEFAULT_MAX_RETRY_COUNT,
  cancelPendingByCampaign,
  claimForSend,
  createLog,
  findById,
  listByCampaign,
  listByGroup,
  listFailedForRetry,
  listPendingByCampaign,
  listRecent,
  listWithFilters,
  markRetrying,
  updateDispatchJobId,
  updatePlannedSchedule,
  updateProviderDelivery,
  updateStatus,
};
