function getClient(client) {
  return client || require("../database/client");
}

async function findById(id, client) {
  const { data, error } = await getClient(client)
    .from("campaigns")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function findAll(client) {
  const { data, error } = await getClient(client)
    .from("campaigns")
    .select("*")
    .is("hidden_at", null);

  if (error) {
    throw error;
  }

  return data || [];
}

// Tamanho de pagina da tela de Campanhas. Espelha o PAGE_SIZE de campanhas.html:
// a tela pedia o historico inteiro e o service montava o resumo de CADA campanha
// (grupos + status, varias consultas por linha) so para exibir as primeiras.
const DEFAULT_CAMPAIGNS_PAGE_SIZE = 30;
const MAX_CAMPAIGNS_PAGE_SIZE = 200;

function resolveCampaignsRange(params = {}) {
  const requested = Number(params.limit);
  const limit =
    Number.isFinite(requested) && requested > 0
      ? Math.min(Math.trunc(requested), MAX_CAMPAIGNS_PAGE_SIZE)
      : DEFAULT_CAMPAIGNS_PAGE_SIZE;
  const rawOffset = Number(params.offset);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.trunc(rawOffset) : 0;

  return { limit, offset };
}

/*
  Uma pagina do historico de campanhas, na ordem do "Periodo de envio" da tela.

  A ordenacao reproduz a chave que campanhas.html montava em memoria
  (campaignSortTimestamp: window_start, caindo para data_envio + horario_envio em
  campanha anterior a janela de disparo). O PostgREST nao ordena por expressao
  sem view/RPC, entao a chave vira uma cascata de colunas:

  - `data_envio` primeiro, e nao window_start: e' o dia do envio e esta
    preenchido em toda campanha, entao as poucas linhas antigas sem janela
    continuam no meio da lista pela data delas, em vez de serem empurradas para
    o fim junto com quem nao tem periodo nenhum;
  - `window_start` resolve a ordem dentro do mesmo dia;
  - `horario_envio` cobre as linhas antigas, que so tem esse horario.

  `nullsFirst: false` mantem o que a tela ja fazia: campanha sem periodo definido
  (ainda em gerando_legendas) fica no fim nos dois sentidos, em vez de encabecar
  a lista quando a ordem e' decrescente. `id` fecha a ordem para a paginacao ser
  estavel entre requisicoes.
*/
async function findAllPage(params = {}, client) {
  const { limit, offset } = resolveCampaignsRange(params);
  const ascending = String(params.sort || "asc").toLowerCase() !== "desc";

  const { data, error, count } = await getClient(client)
    .from("campaigns")
    .select("*", { count: "exact" })
    .is("hidden_at", null)
    .order("data_envio", { ascending, nullsFirst: false })
    .order("window_start", { ascending, nullsFirst: false })
    .order("horario_envio", { ascending, nullsFirst: false })
    .order("id", { ascending })
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

async function listActive(client) {
  const { data, error } = await getClient(client)
    .from("campaigns")
    .select("*")
    .eq("ativo", true)
    .is("hidden_at", null);

  if (error) {
    throw error;
  }

  return data || [];
}

async function listByStatusOlderThan(status, cutoffDate, client) {
  const { data, error } = await getClient(client)
    .from("campaigns")
    .select("*")
    .eq("status", status)
    .lt("status_changed_at", cutoffDate instanceof Date ? cutoffDate.toISOString() : cutoffDate);

  if (error) {
    throw error;
  }

  return data || [];
}

// Campanhas ativas cuja janela cruza [windowStart, windowEnd). A comparacao
// e feita no banco (start < fim_novo AND fim > inicio_novo) para nao carregar o
// historico inteiro so para descartar quase tudo em memoria. Campanhas sem
// janela definida ficam de fora: nao ha intervalo para comparar.
async function listActiveOverlappingWindow(windowStart, windowEnd, options = {}, client) {
  const start = windowStart instanceof Date ? windowStart.toISOString() : windowStart;
  const end = windowEnd instanceof Date ? windowEnd.toISOString() : windowEnd;

  let query = getClient(client)
    .from("campaigns")
    .select("*")
    .eq("ativo", true)
    .not("window_start", "is", null)
    .not("window_end", "is", null)
    .lt("window_start", end)
    .gt("window_end", start);

  if (options.excludeId) {
    query = query.neq("id", options.excludeId);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return data || [];
}

async function create(payload, client) {
  const { data, error } = await getClient(client)
    .from("campaigns")
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

// Reivindicacao atomica de "este trigger e quem cria os jobs de disparo":
// so grava trigger_fired_at se ainda estiver nulo e a campanha nao estiver
// pausada/cancelada. Evita que uma campanha pausada/cancelada bem no instante
// em que o job do campaign-trigger dispara ainda assim gere os jobs por grupo,
// e tambem protege contra um segundo job de trigger perdido para a mesma
// campanha (so o primeiro a reivindicar segue adiante).
async function claimTriggerFired(id, client) {
  const { data, error } = await getClient(client)
    .from("campaigns")
    .update({ trigger_fired_at: new Date().toISOString() })
    .eq("id", id)
    .is("trigger_fired_at", null)
    .not("status", "in", "(pausado,cancelado)")
    .select("*")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

// Devolve trigger_fired_at para nulo, para que a campanha possa disparar de
// novo.
//
// Existe por causa de uma armadilha do claimTriggerFired acima: ele e' atomico e
// irreversivel, e o campaign-trigger o reivindica ANTES de criar os jobs de
// disparo. Se o processor falhasse depois disso por um erro transitorio (Supabase
// instavel, Redis reconectando), a campanha ficava reivindicada para sempre - um
// retry do job encontrava o claim perdido e virava no-op, e nem uma acao manual
// fazia a campanha disparar. O catch entao gravava ativo:false e o operador via
// "o sistema cancelou sozinho".
//
// So deve ser chamado quando NENHUM job de disparo foi criado ainda: com jobs na
// fila, liberar o claim permitiria uma segunda rodada enfileirar o mesmo trio de
// novo. A condicao `is("trigger_fired_at", not null)` evita competir com quem
// ja liberou.
async function releaseTriggerClaim(id, client) {
  const { data, error } = await getClient(client)
    .from("campaigns")
    .update({ trigger_fired_at: null })
    .eq("id", id)
    .not("trigger_fired_at", "is", null)
    .select("*")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function update(id, payload, client) {
  const { data, error } = await getClient(client)
    .from("campaigns")
    .update(payload)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function remove(id, client) {
  const { data, error } = await getClient(client)
    .from("campaigns")
    .delete()
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

// Usado quando "apagar registros do relatorio por periodo" esvazia todos os
// logs visiveis de uma campanha: a campanha some das listagens junto (findAll/
// listActive ja filtram hidden_at), sem apagar a linha - so o historico do
// relatorio (logs) que motivou a ocultacao e removido, nunca a campanha em si.
async function hideByIds(campaignIds, client) {
  if (!Array.isArray(campaignIds) || campaignIds.length === 0) {
    return [];
  }

  const { data, error } = await getClient(client)
    .from("campaigns")
    .update({ hidden_at: new Date().toISOString() })
    .in("id", campaignIds)
    .is("hidden_at", null)
    .select("id");

  if (error) {
    throw error;
  }

  return data || [];
}

module.exports = {
  claimTriggerFired,
  create,
  delete: remove,
  findAll,
  findAllPage,
  findById,
  hideByIds,
  listActive,
  listActiveOverlappingWindow,
  listByStatusOlderThan,
  releaseTriggerClaim,
  remove,
  update,
};
