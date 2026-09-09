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

// Colunas acrescentadas por migration que o codigo passou a preencher, mas que
// podem AINDA nao existir no banco.
//
// Isto existe por uma razao operacional concreta: o projeto nao tem CLI do
// Supabase linkado, e o playbook de deploy (CLAUDE.md) aplica migrations
// MANUALMENTE, no fim - depois de o codigo novo ja estar rodando. Sem tolerancia,
// a janela entre "container novo no ar" e "SQL colado no editor" seria uma
// interrupcao total: o Postgrest recusa o INSERT inteiro com PGRST204/42703 por
// causa de uma coluna desconhecida, e NENHUM envio conseguiria criar log - ou
// seja, nenhum envio aconteceria. Foi exatamente a forma do incidente de
// organizations (migration 202608280001), com a diferenca de que ali a coluna
// errada derrubava um PATCH e aqui derrubaria o disparo.
//
// Degradar e' seguro para estas colunas porque nenhuma delas participa de
// decisao de envio: dispatch_ref e' correlacao de log. Perder o valor durante a
// janela de deploy custa rastreabilidade daquelas linhas, nunca uma entrega.
const OPTIONAL_LOG_COLUMNS = ["dispatch_ref"];

const MISSING_COLUMN_ERROR_CODES = new Set(["PGRST204", "42703"]);
const reportedMissingColumns = new Set();

function findMissingOptionalColumn(error) {
  if (!error || !MISSING_COLUMN_ERROR_CODES.has(String(error.code))) {
    return null;
  }

  const haystack = `${error.message || ""} ${error.details || ""} ${error.hint || ""}`;

  return OPTIONAL_LOG_COLUMNS.find((column) => haystack.includes(column)) || null;
}

async function insertLog(payload, client) {
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

async function createLog(payload, client) {
  traceOrphanLogCreation(payload);

  try {
    return await insertLog(payload, client);
  } catch (error) {
    const missingColumn = findMissingOptionalColumn(error);

    if (!missingColumn) {
      throw error;
    }

    // Uma vez por coluna por processo: repetir por envio afogaria o log sem
    // informacao nova, mas silenciar por completo esconderia uma migration
    // esquecida indefinidamente.
    if (!reportedMissingColumns.has(missingColumn)) {
      reportedMissingColumns.add(missingColumn);
      console.warn(
        JSON.stringify({
          event: "dispatch_logs.optional_column_missing",
          column: missingColumn,
          note:
            `a coluna "${missingColumn}" nao existe no banco; o log sera gravado sem ela. ` +
            "Aplique as migrations pendentes de supabase/migrations para restaurar a rastreabilidade.",
          error_code: error.code,
        })
      );
    }

    const { [missingColumn]: _dropped, ...withoutColumn } = payload;

    return insertLog(withoutColumn, client);
  }
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

// Estados que significam "este trio ja tem envio em andamento ou concluido".
// Espelham o WHERE do indice unico parcial criado em
// 202609070002_add_logs_trio_unique_index.sql.
const ACTIVE_TRIO_STATUSES = ["pendente", "processando", "enviado"];

// Log de UM trio campanha/grupo/video, filtrado no banco.
//
// Substitui o padrao "listByCampaign + .find() em memoria" que sustentava a
// checagem de idempotencia do envio. Aquele padrao tinha dois problemas, e o
// segundo era de correcao, nao de custo:
//
//  1. Escala quadratica: executeDispatch fazia TRES varreduras da tabela por
//     grupo enviado, e isCampaignFullyTerminal uma quarta. Uma campanha
//     recorrente ganha G linhas por execucao e paga 4G varreduras na seguinte.
//
//  2. O PostgREST aplica um teto de linhas por resposta (db-max-rows; 1000 no
//     default do Supabase) e o corte e' SILENCIOSO. Como a ordem era
//     criado_em DESC, o log "enviado" antigo era justamente o primeiro a cair
//     fora do resultado - e a checagem de idempotencia deixava de ver o envio
//     ja feito. O video seria postado de novo no grupo, sem nenhum erro em
//     lugar nenhum.
//
// Com `limit(1)` e filtro no banco, nao existe teto para estourar.
async function findByTrio(campaignId, groupId, videoId, statuses = ACTIVE_TRIO_STATUSES, client) {
  if (!campaignId || !groupId) {
    return null;
  }

  let query = getClient(client)
    .from(LOGS_TABLE)
    .select("*")
    .eq("campaign_id", campaignId)
    .eq("group_id", groupId);

  // video_id e' nulo em disparo pontual (mensagem sem video). `.is` e `.eq` nao
  // sao intercambiaveis no Postgrest: `eq.null` nao casa linha nenhuma.
  query = videoId ? query.eq("video_id", videoId) : query.is("video_id", null);

  if (Array.isArray(statuses) && statuses.length) {
    query = query.in("status", statuses);
  }

  const { data, error } = await query
    .order("criado_em", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

// Quantos grupos da campanha ainda NAO tem log em estado terminal.
//
// Substitui a varredura completa que isCampaignFullyTerminal fazia para depois
// reduzir em memoria. `head: true` nao transfere linha nenhuma - so a contagem.
async function countNonTerminalByCampaign(campaignId, terminalStatuses, client) {
  const { count, error } = await getClient(client)
    .from(LOGS_TABLE)
    .select("*", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .not("status", "in", `(${terminalStatuses.join(",")})`);

  if (error) {
    throw error;
  }

  return count || 0;
}

// Grupos distintos da campanha que ja tem log em estado terminal.
// Complementa countNonTerminalByCampaign: e' preciso saber se TODO grupo
// associado chegou ao fim, nao apenas que nao sobrou log pendente.
async function listTerminalGroupIdsByCampaign(campaignId, terminalStatuses, client) {
  const { data, error } = await getClient(client)
    .from(LOGS_TABLE)
    .select("group_id")
    .eq("campaign_id", campaignId)
    .in("status", terminalStatuses);

  if (error) {
    throw error;
  }

  return [...new Set((data || []).map((row) => row.group_id).filter(Boolean))];
}

// ATENCAO: sem limite, e por isso NAO deve ser usada em caminho de envio.
// Sobrou para telas e relatorios de uma campanha especifica (getDispatchStatus,
// getGroupsDetail). A checagem de idempotencia usa findByTrio; a de campanha
// concluida usa as duas funcoes acima.
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

// Statuses exibidos no resumo do relatorio.
const REPORT_SUMMARY_STATUSES = ["pendente", "processando", "enviado", "erro", "falhou", "cancelado"];

// Tamanho de pagina do relatorio. Espelha o PAGE_SIZE de relatorios.html, que
// antes recortava em memoria um resultado que vinha inteiro do banco.
const DEFAULT_REPORT_PAGE_SIZE = 100;
const MAX_REPORT_PAGE_SIZE = 500;

function resolveReportRange(filters = {}) {
  const requested = Number(filters.limit);
  const limit = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.trunc(requested), MAX_REPORT_PAGE_SIZE)
    : DEFAULT_REPORT_PAGE_SIZE;
  const rawOffset = Number(filters.offset);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.trunc(rawOffset) : 0;

  return { limit, offset };
}

// O apelido de app_users precisa nomear a FK (`!logs_cancelado_por_fkey`): a
// tabela `logs` referencia app_users por DUAS colunas (usuario_responsavel_id e
// cancelado_por), e sem desambiguar o Postgrest recusa o embed inteiro -
// derrubando o relatorio, nao so a coluna.
//
// `groups` recebe `!inner` APENAS quando ha filtro por organizacao: ai o join
// precisa ser interno para o filtro valer no banco. Sem o filtro ele fica
// externo, senao um log cujo grupo foi removido desapareceria do relatorio.
function buildReportSelect({ filterByOrganization }) {
  const groupsEmbed = filterByOrganization
    ? "groups!inner(id, nome, organization_id, organizations(id, nome))"
    : "groups(id, nome, organization_id, organizations(id, nome))";

  return (
    "*, campaigns(id, trilha, data_envio, horario_envio, tipo, possui_midia, link_conteudo), " +
    `${groupsEmbed}, ` +
    "video_catalog(id, nome_do_arquivo), whatsapp_instances(id, instance_name, phone_number), " +
    "cancelado_por_usuario:app_users!logs_cancelado_por_fkey(id, username, display_name)"
  );
}

function applyReportFilters(query, filters = {}) {
  let next = query.is("hidden_at", null);

  if (filters.startDate) {
    next = next.gte("criado_em", filters.startDate);
  }

  if (filters.endDate) {
    next = next.lte("criado_em", filters.endDate);
  }

  if (filters.groupId) {
    next = next.eq("group_id", filters.groupId);
  }

  if (filters.status) {
    next = next.eq("status", filters.status);
  }

  // Empurrado para o banco. Antes o service buscava TODAS as linhas do periodo e
  // filtrava por organizacao em memoria com .filter() - o custo completo era
  // pago para descartar a maior parte do resultado.
  if (filters.organizationId) {
    next = next.eq("groups.organization_id", filters.organizationId);
  }

  return next;
}

/*
  Uma pagina do relatorio, com o total do filtro.

  Antes esta funcao devolvia TODAS as linhas do periodo com cinco tabelas
  embutidas, sem limit nem range - a requisicao mais pesada do sistema, disparada
  pela tela mais usada, e materializada por inteiro no heap da API e no do
  navegador. A "paginacao" existia so no cliente (rows.slice), ou seja, o custo
  inteiro era pago para exibir 100 linhas.

  E havia um risco de correcao junto: o PostgREST corta a resposta no
  db-max-rows (1000 no default do Supabase) SEM avisar. Acima disso o relatorio
  passava a mentir por omissao - mostrando "N registros" que nao eram o total.
  Com range explicito e `count: "exact"`, o total vem do banco e a pagina e' o
  que foi pedido.
*/
async function listWithFilters(filters = {}, client) {
  const { limit, offset } = resolveReportRange(filters);
  const select = buildReportSelect({ filterByOrganization: Boolean(filters.organizationId) });

  const query = applyReportFilters(
    getClient(client).from(LOGS_TABLE).select(select, { count: "exact" }),
    filters
  );

  const { data, error, count } = await query
    .order("criado_em", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    throw error;
  }

  const rows = data || [];

  return {
    rows,
    total: typeof count === "number" ? count : rows.length,
    limit,
    offset,
  };
}

/*
  Contagem por status para os cartoes de resumo do relatorio.

  Necessaria porque a tela calcula o resumo sobre o conjunto INTEIRO do filtro,
  nao sobre a pagina exibida - paginar sem isto faria os cartoes passarem a
  contar so 100 linhas. Sao consultas com `head: true`, que devolvem apenas o
  numero e nao transferem linha nenhuma; rodam em paralelo.

  O Postgrest nao faz GROUP BY sem RPC/view, entao uma contagem por status e' a
  forma honesta de obter isso sem criar objeto novo no banco.
*/
async function countByStatusWithFilters(filters = {}, client) {
  const select = buildReportSelect({ filterByOrganization: Boolean(filters.organizationId) });
  const statuses = filters.status ? [filters.status] : REPORT_SUMMARY_STATUSES;

  const entries = await Promise.all(
    statuses.map(async (status) => {
      const query = applyReportFilters(
        getClient(client).from(LOGS_TABLE).select(select, { count: "exact", head: true }),
        { ...filters, status }
      );

      const { error, count } = await query;

      if (error) {
        throw error;
      }

      return [status, count || 0];
    })
  );

  const counts = {};

  for (const status of REPORT_SUMMARY_STATUSES) {
    counts[status] = 0;
  }

  for (const [status, count] of entries) {
    counts[status] = count;
  }

  return counts;
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
  ACTIVE_TRIO_STATUSES,
  CANCEL_ORIGENS,
  DEFAULT_REPORT_PAGE_SIZE,
  MAX_REPORT_PAGE_SIZE,
  REPORT_SUMMARY_STATUSES,
  countByStatusWithFilters,
  DEFAULT_FAILED_RETRY_BATCH_SIZE,
  DEFAULT_MAX_RETRY_COUNT,
  cancelIfPending,
  cancelPendingByCampaign,
  claimForSend,
  countNonTerminalByCampaign,
  countVisibleByCampaignIds,
  createLog,
  findById,
  findByTrio,
  listTerminalGroupIdsByCampaign,
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
