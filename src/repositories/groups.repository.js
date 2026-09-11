function getClient(client) {
  return client || require("../database/client");
}

async function findById(id, client) {
  const { data, error } = await getClient(client)
    .from("groups")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function findByEvolutionGroupId(evolutionGroupId, client) {
  const { data, error } = await getClient(client)
    .from("groups")
    .select("*")
    .eq("evolution_group_id", evolutionGroupId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function findAll(client) {
  const { data, error } = await getClient(client)
    .from("groups")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function listByOrganization(organizationId, client) {
  const { data, error } = await getClient(client)
    .from("groups")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function listVideoEnabled(client) {
  const { data, error } = await getClient(client)
    .from("groups")
    .select("*")
    .eq("envia_video", true)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function listWithoutSegment(params, client) {
  const options = params && typeof params === "object" && !params.from ? params : {};
  const databaseClient = params && typeof params === "object" && params.from ? params : client;
  let query = getClient(databaseClient)
    .from("groups")
    .select("*")
    .is("segmento", null)
    .order("created_at", { ascending: false });

  const nameContains = String(options.name_contains || options.nameContains || "").trim();

  if (nameContains) {
    query = query.ilike("nome", `%${nameContains}%`);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return data || [];
}

// Tamanho de pagina da tela de Grupos. Espelha o PAGE_SIZE de grupos.html, que
// antes pedia a lista inteira e recortava/filtrava em memoria - o custo completo
// era pago para exibir algumas dezenas de linhas, e acima do db-max-rows do
// PostgREST (1000 no default do Supabase) a tela passava a mentir por omissao.
const DEFAULT_GROUPS_PAGE_SIZE = 50;
const MAX_GROUPS_PAGE_SIZE = 200;

function resolveGroupsRange(params = {}) {
  const requested = Number(params.limit);
  const limit =
    Number.isFinite(requested) && requested > 0
      ? Math.min(Math.trunc(requested), MAX_GROUPS_PAGE_SIZE)
      : DEFAULT_GROUPS_PAGE_SIZE;
  const rawOffset = Number(params.offset);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.trunc(rawOffset) : 0;

  return { limit, offset };
}

// Os mesmos filtros que a tela de Grupos aplicava no navegador, agora no banco:
// com a pagina recortada no servidor, filtrar depois deixaria a tela exibindo
// so o que sobrou de 50 linhas em vez de 50 linhas que passam no filtro.
function applySearchFilters(query, params = {}) {
  let next = query;

  const nameContains = String(params.name_contains || params.nameContains || "").trim();

  if (nameContains) {
    next = next.ilike("nome", `%${nameContains}%`);
  }

  const classification = String(params.classification || "").trim();

  if (classification === "classificados") {
    next = next.not("segmento", "is", null);
  } else if (classification === "nao-classificados") {
    next = next.is("segmento", null);
  }

  const organizationId = params.organization_id || params.organizationId;

  if (organizationId) {
    next = next.eq("organization_id", organizationId);
  }

  const profileId = params.profile_id || params.profileId;

  if (profileId) {
    // Grupo legado sem profile_id continua saindo pelo nome do perfil gravado em
    // `segmento` - era o fallback que a tela fazia em memoria
    // (resolveProfileIdFromSegmento). Sem ele, filtrar por perfil sumiria com
    // esses grupos em vez de apenas pagina-los.
    const profileNome = String(params.profile_nome || params.profileNome || "").trim();
    const fallbackIsSafe = profileNome && !/[,()]/.test(profileNome);

    next = fallbackIsSafe
      ? next.or(`profile_id.eq.${profileId},and(profile_id.is.null,segmento.ilike.${profileNome})`)
      : next.eq("profile_id", profileId);
  }

  const setor = String(params.setor || "").trim();

  if (setor) {
    next = next.ilike("setor", setor);
  }

  const enviaVideo = params.envia_video !== undefined ? params.envia_video : params.enviaVideo;

  if (enviaVideo === "sim" || enviaVideo === true) {
    next = next.eq("envia_video", true);
  } else if (enviaVideo === "nao" || enviaVideo === false) {
    next = next.eq("envia_video", false);
  }

  const whatsappInstanceId = params.whatsapp_instance_id || params.whatsappInstanceId;

  if (whatsappInstanceId && whatsappInstanceId !== "todos") {
    next = next.eq("group_whatsapp_instances.whatsapp_instance_id", whatsappInstanceId);
  }

  return next;
}

// O vinculo grupo<->numero mora em group_whatsapp_instances: o embed `!inner`
// leva esse filtro para o banco (a alternativa seria mandar na URL a lista
// inteira de group_ids do numero). O vinculo e' unico por (grupo, numero),
// entao o join nao duplica linha nem infla o `count`.
function buildSearchSelect(params = {}) {
  const whatsappInstanceId = params.whatsapp_instance_id || params.whatsappInstanceId;

  return whatsappInstanceId && whatsappInstanceId !== "todos"
    ? "*, group_whatsapp_instances!inner(whatsapp_instance_id)"
    : "*";
}

// O embed acima existe so para filtrar; quem diz quais numeros cada grupo tem e'
// o attachInstanceIds do service, entao a coluna embutida nao vaza na resposta.
function stripEmbeddedInstances(row) {
  if (!row || !Object.prototype.hasOwnProperty.call(row, "group_whatsapp_instances")) {
    return row;
  }

  const { group_whatsapp_instances: embedded, ...group } = row;

  return group;
}

async function searchByName(params = {}, client) {
  const query = applySearchFilters(
    getClient(client).from("groups").select(buildSearchSelect(params)),
    params
  );

  const { data, error } = await query.order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data || []).map(stripEmbeddedInstances);
}

// Uma pagina da busca, com o total do filtro inteiro - o cabecalho da tela
// continua dizendo quantos grupos existem, nao quantos couberam na pagina.
// `id` entra na ordenacao como desempate: sem ele, grupos que compartilham o
// mesmo created_at podem trocar de lugar entre uma pagina e outra, e um grupo
// some da listagem sem nunca ter sido exibido.
async function searchPage(params = {}, client) {
  const { limit, offset } = resolveGroupsRange(params);
  const query = applySearchFilters(
    getClient(client).from("groups").select(buildSearchSelect(params), { count: "exact" }),
    params
  );

  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    throw error;
  }

  const rows = (data || []).map(stripEmbeddedInstances);

  return {
    rows,
    total: typeof count === "number" ? count : rows.length,
    limit,
    offset,
  };
}

async function countAll(client) {
  const { count, error } = await getClient(client)
    .from("groups")
    .select("*", { count: "exact", head: true });

  if (error) {
    throw error;
  }

  return count || 0;
}

// Setores distintos entre TODOS os grupos: alimentam o filtro da tela e o select
// do modal de edicao, que antes eram derivados da lista completa carregada no
// navegador. O PostgREST nao faz DISTINCT sem view/RPC, entao a coluna (uma so,
// de texto) e' varrida em lotes e a deduplicacao acontece aqui. Os lotes existem
// porque uma leitura unica seria cortada em silencio no db-max-rows.
const SETORES_SCAN_BATCH = 1000;
const SETORES_SCAN_MAX_BATCHES = 20;

async function listDistinctSetores(client) {
  const databaseClient = getClient(client);
  const seen = new Map();

  for (let batch = 0; batch < SETORES_SCAN_MAX_BATCHES; batch += 1) {
    const from = batch * SETORES_SCAN_BATCH;
    const { data, error } = await databaseClient
      .from("groups")
      .select("setor")
      .not("setor", "is", null)
      .order("id", { ascending: true })
      .range(from, from + SETORES_SCAN_BATCH - 1);

    if (error) {
      throw error;
    }

    const rows = data || [];

    rows.forEach((row) => {
      const value = String(row.setor || "").trim();

      if (!value) {
        return;
      }

      // Mesma chave acento-insensivel que a tela usava para nao listar
      // "Comercial" e "comerciál" como dois setores diferentes.
      const key = value
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase();

      if (!seen.has(key)) {
        seen.set(key, value);
      }
    });

    if (rows.length < SETORES_SCAN_BATCH) {
      break;
    }
  }

  return [...seen.values()].sort((left, right) => left.localeCompare(right, "pt-BR"));
}

async function create(payload, client) {
  const { data, error } = await getClient(client)
    .from("groups")
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function update(id, payload, client) {
  const { data, error } = await getClient(client)
    .from("groups")
    .update(payload)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

// Compare-and-swap: so aplica o update se trilha_id ainda for o valor esperado no
// momento da leitura. Usado pelo avanco automatico de trilha (group-video-flow.js)
// para nao corromper o progresso quando dois ticks de disparo sobrepostos (ou duas
// campanhas) leem o mesmo grupo e tentam avancar ao mesmo tempo - quem perde a
// corrida recebe null e pula o avanco nesta rodada em vez de sobrescrever o outro.
async function updateTrilhaIfCurrent(id, expectedTrilhaId, payload, client) {
  const resolvedClient = getClient(client);
  let query = resolvedClient.from("groups").update(payload).eq("id", id);

  query = expectedTrilhaId === null ? query.is("trilha_id", null) : query.eq("trilha_id", expectedTrilhaId);

  const { data, error } = await query.select("*").maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function remove(id, client) {
  const { data, error } = await getClient(client)
    .from("groups")
    .delete()
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

// Remove varios grupos de uma vez. Usado ao desconectar um numero da Evolution
// API: os grupos que so eram visiveis por aquele numero deixam de ser
// alcancaveis por qualquer disparo, entao saem do banco junto com ele.
async function removeMany(ids, client) {
  if (!ids || ids.length === 0) {
    return [];
  }

  const { data, error } = await getClient(client).from("groups").delete().in("id", ids).select("*");

  if (error) {
    throw error;
  }

  return data || [];
}

async function countByTrilhaId(trilhaId, client) {
  const { count, error } = await getClient(client)
    .from("groups")
    .select("*", { count: "exact", head: true })
    .eq("trilha_id", trilhaId);

  if (error) {
    throw error;
  }

  return count || 0;
}

module.exports = {
  countAll,
  countByTrilhaId,
  create,
  delete: remove,
  findAll,
  findByEvolutionGroupId,
  findById,
  listByOrganization,
  listDistinctSetores,
  searchByName,
  searchPage,
  listVideoEnabled,
  listWithoutSegment,
  remove,
  removeMany,
  update,
  updateTrilhaIfCurrent,
};
