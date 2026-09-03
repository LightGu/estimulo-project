function getClient(client) {
  return client || require("../database/client");
}

const LOGS_TABLE = "logs";

// Espelham MAX_RETRY_ATTEMPTS do worker de retry; ficam aqui para que a query
// consiga filtrar/limitar sem depender da camada de queues.
const DEFAULT_MAX_RETRY_COUNT = 3;
const DEFAULT_FAILED_RETRY_BATCH_SIZE = 25;

const CANCELED_STATUS = "cancelado";

// Vocabulario fechado de `logs.cancelado_origem` (ver a migration
// 202609020002). Existe porque, ate ela, um cancelamento pedido pelo usuario e
// um cancelamento automatico por atraso ficavam identicos na tabela - e
// responder "quem cancelou este envio?" exigia ler o codigo em vez do banco.
const CANCEL_ORIGENS = {
  USUARIO: "usuario",
  ATRASO: "atraso",
  CAMPANHA_CANCELADA: "campanha_cancelada",
  SISTEMA: "sistema",
};

// Campos de auditoria aplicados a TODO caminho que grava status "cancelado".
// Centralizado para que um caminho novo nao volte a cancelar em silencio.
//
// `usuarioId` fica nulo de proposito nos cancelamentos automaticos (trava de
// atraso, worker): ali nao existe conta por tras da acao, e a resposta certa
// para "quem cancelou?" e "ninguem" - a origem ja diz o que foi.
function buildCancelAudit(origem, options = {}) {
  const { usuarioId = null, at = new Date() } = options;

  return {
    cancelado_em: at.toISOString(),
    cancelado_origem: origem || CANCEL_ORIGENS.SISTEMA,
    cancelado_por: usuarioId || null,
  };
}

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

async function updateStatus(id, status, mensagemErro = null, whatsappInstanceId, client) {
  const update = { status, mensagem_erro: mensagemErro };

  if (whatsappInstanceId !== undefined) {
    update.whatsapp_instance_id = whatsappInstanceId;
  }

  // Caminho generico: quem cancela por aqui nao informa a origem (e o fallback
  // de mensagens-dispatch quando cancelIfPending nao esta disponivel), mas o
  // INSTANTE do cancelamento nao pode se perder - era justamente o dado que
  // faltava para investigar um envio cancelado.
  if (status === CANCELED_STATUS) {
    Object.assign(update, buildCancelAudit(CANCEL_ORIGENS.SISTEMA));
  }

  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .update(update)
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

async function updateInstance(id, whatsappInstanceId, client) {
  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .update({ whatsapp_instance_id: whatsappInstanceId })
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
async function cancelPendingByCampaign(campaignId, options = {}, client) {
  const { motivo, origem = CANCEL_ORIGENS.CAMPANHA_CANCELADA, usuarioId = null } = options || {};

  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .update({
      status: CANCELED_STATUS,
      // Sem esta mensagem, um envio cancelado pelo usuario chegava ao relatorio
      // com mensagem_erro NULL - visualmente identico a um cancelamento
      // automatico cuja mensagem tivesse se perdido. O operador via so
      // "Cancelado", sem saber se foi ele ou a plataforma.
      mensagem_erro: motivo || "Envio cancelado: a campanha foi cancelada no painel.",
      ...buildCancelAudit(origem, { usuarioId }),
    })
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

// Cancelamento por atraso (dispatch-staleness.js): so aplica se a linha ainda
// estiver pendente nesse instante, para nao sobrescrever um log que outro
// worker ja tenha movido para processando/enviado/falhou entre a leitura do
// horario planejado e este UPDATE.
async function cancelIfPending(id, mensagemErro = null, options = {}, client) {
  const { origem = CANCEL_ORIGENS.ATRASO, usuarioId = null } = options || {};

  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .update({
      status: CANCELED_STATUS,
      mensagem_erro: mensagemErro,
      ...buildCancelAudit(origem, { usuarioId }),
    })
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
      // O apelido de app_users precisa nomear a FK (`!logs_cancelado_por_fkey`):
      // a tabela `logs` referencia app_users por DUAS colunas
      // (usuario_responsavel_id e cancelado_por), e sem desambiguar o Postgrest
      // recusa o embed inteiro - derrubando o relatorio, nao so a coluna.
      "*, campaigns(id, trilha, data_envio, horario_envio, tipo, possui_midia, link_conteudo), groups(id, nome, organization_id, organizations(id, nome)), video_catalog(id, nome_do_arquivo), whatsapp_instances(id, instance_name, phone_number), cancelado_por_usuario:app_users!logs_cancelado_por_fkey(id, username, display_name)"
    )
    .is("hidden_at", null)
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

// Usado pelo endpoint "apagar registros do relatorio por periodo": nunca
// remove a linha - so marca hidden_at, que listWithFilters (o relatorio) ja
// passa a excluir. Devolve os logs afetados para o service decidir quais
// campanhas ficaram com todos os logs ocultos.
async function hideByDateRange(startDate, endDate, client) {
  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .update({ hidden_at: new Date().toISOString() })
    .gte("criado_em", startDate)
    .lte("criado_em", endDate)
    .is("hidden_at", null)
    .select("id, campaign_id");

  if (error) {
    throw error;
  }

  return data || [];
}

// Conta, por campanha, quantos logs ainda estao visiveis (hidden_at nulo).
// Usado apos hideByDateRange para saber quais das campanhas afetadas nao tem
// mais nenhum log visivel e por isso devem ser ocultadas junto.
async function countVisibleByCampaignIds(campaignIds, client) {
  if (!Array.isArray(campaignIds) || campaignIds.length === 0) {
    return {};
  }

  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .select("campaign_id")
    .in("campaign_id", campaignIds)
    .is("hidden_at", null);

  if (error) {
    throw error;
  }

  const counts = {};
  for (const campaignId of campaignIds) {
    counts[campaignId] = 0;
  }
  for (const row of data || []) {
    counts[row.campaign_id] = (counts[row.campaign_id] || 0) + 1;
  }

  return counts;
}

// Usado pela lista de campanhas para exibir "quem programou": um log so grava
// usuario_responsavel_id quando a confirmacao veio de uma acao no painel (ver
// confirmDispatch/scheduleAdHoc em mensagens.service.js/campaigns.service.js);
// jobs automaticos de fila deixam a coluna nula. Ordenado por criado_em
// ascendente para que o service fique com o primeiro log gravado de cada
// campanha - a confirmacao original, mesmo que a campanha tenha sido
// reagendada depois por outra pessoa.
async function listResponsibleUsersByCampaigns(campaignIds, client) {
  if (!Array.isArray(campaignIds) || campaignIds.length === 0) {
    return [];
  }

  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .select("campaign_id, usuario_responsavel_id, criado_em")
    .in("campaign_id", campaignIds)
    .not("usuario_responsavel_id", "is", null)
    .order("criado_em", { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

module.exports = {
  CANCEL_ORIGENS,
  DEFAULT_FAILED_RETRY_BATCH_SIZE,
  DEFAULT_MAX_RETRY_COUNT,
  cancelIfPending,
  cancelPendingByCampaign,
  claimForSend,
  countVisibleByCampaignIds,
  createLog,
  findById,
  hideByDateRange,
  listByCampaign,
  listByGroup,
  listFailedForRetry,
  listPendingByCampaign,
  listRecent,
  listResponsibleUsersByCampaigns,
  listWithFilters,
  markRetrying,
  updateDispatchJobId,
  updateInstance,
  updatePlannedSchedule,
  updateProviderDelivery,
  updateStatus,
};
