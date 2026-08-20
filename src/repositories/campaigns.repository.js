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
    .select("*");

  if (error) {
    throw error;
  }

  return data || [];
}

async function listActive(client) {
  const { data, error } = await getClient(client)
    .from("campaigns")
    .select("*")
    .eq("ativo", true);

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

module.exports = {
  claimTriggerFired,
  create,
  delete: remove,
  findAll,
  findById,
  listActive,
  listActiveOverlappingWindow,
  listByStatusOlderThan,
  remove,
  update,
};
