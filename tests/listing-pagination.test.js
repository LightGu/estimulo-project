/*
  Paginacao no servidor das telas de Grupos (50 por pagina) e Campanhas (30 por
  pagina).

  As duas telas pediam a lista inteira e recortavam no navegador: filtrar e
  ordenar depois de um recorte feito aqui devolveria "50 grupos" dos quais so
  alguns passam no filtro, e uma "ordem por periodo" que so vale dentro da
  pagina. Os testes abaixo cobrem o que essa mudanca precisa garantir:

  - os filtros da tela de Grupos viram condicoes no banco (nao sobram para o
    cliente aplicar depois do recorte);
  - `count: "exact"` acompanha a pagina, para o total exibido ser o do filtro
    inteiro e nao o tamanho da pagina;
  - o formato antigo (array puro) continua valendo para quem nao pagina - sao
    sete outras telas consumindo /groups/search e /campaigns.
*/
const assert = require("node:assert/strict");

const groupsRepository = require("../src/repositories/groups.repository");
const campaignsRepository = require("../src/repositories/campaigns.repository");
const { createGroupsService } = require("../src/services/groups.service");
const { createCampaignsService } = require("../src/services/campaigns.service");
const createApp = require("../src/api/app");

// Cliente Supabase de mentira: registra o que foi pedido (filtros, ordenacao,
// range) e devolve as linhas configuradas.
function createMockClient(rows, count) {
  const calls = [];
  const builder = {
    select(columns, options) {
      calls.push({ type: "select", columns, options });
      return this;
    },
    eq(column, value) {
      calls.push({ type: "eq", column, value });
      return this;
    },
    is(column, value) {
      calls.push({ type: "is", column, value });
      return this;
    },
    not(column, operator, value) {
      calls.push({ type: "not", column, operator, value });
      return this;
    },
    ilike(column, value) {
      calls.push({ type: "ilike", column, value });
      return this;
    },
    or(condition) {
      calls.push({ type: "or", condition });
      return this;
    },
    order(column, options) {
      calls.push({ type: "order", column, options });
      return this;
    },
    range(from, to) {
      calls.push({ type: "range", from, to });
      return Promise.resolve({ data: rows, error: null, count });
    },
  };

  return {
    calls,
    client: {
      from(table) {
        calls.push({ type: "from", table });
        return builder;
      },
    },
  };
}

function findCall(calls, predicate) {
  return calls.find(predicate);
}

async function testGroupsRepositoryPage() {
  const { calls, client } = createMockClient([{ id: "group-1", nome: "Grupo 1" }], 137);

  const page = await groupsRepository.searchPage(
    {
      name_contains: "zona",
      classification: "classificados",
      organization_id: "org-1",
      profile_id: "profile-1",
      profile_nome: "Pre infancia",
      setor: "Comercial",
      envia_video: "sim",
      whatsapp_instance_id: "instance-1",
      limit: 50,
      offset: 50,
    },
    client
  );

  assert.deepEqual(page.rows, [{ id: "group-1", nome: "Grupo 1" }]);
  assert.equal(page.total, 137, "o total tem de vir do count do banco, nao do tamanho da pagina");
  assert.equal(page.limit, 50);
  assert.equal(page.offset, 50);

  const select = findCall(calls, (call) => call.type === "select");
  assert.equal(select.options.count, "exact");
  assert.match(select.columns, /group_whatsapp_instances!inner/, "o filtro por numero precisa do join no banco");

  assert.ok(findCall(calls, (call) => call.type === "ilike" && call.column === "nome" && call.value === "%zona%"));
  assert.ok(findCall(calls, (call) => call.type === "not" && call.column === "segmento" && call.operator === "is"));
  assert.ok(findCall(calls, (call) => call.type === "eq" && call.column === "organization_id" && call.value === "org-1"));
  assert.ok(findCall(calls, (call) => call.type === "ilike" && call.column === "setor" && call.value === "Comercial"));
  assert.ok(findCall(calls, (call) => call.type === "eq" && call.column === "envia_video" && call.value === true));
  assert.ok(
    findCall(
      calls,
      (call) => call.type === "eq" && call.column === "group_whatsapp_instances.whatsapp_instance_id" && call.value === "instance-1"
    )
  );

  // Grupo legado sem profile_id continua saindo pelo nome do perfil gravado em
  // `segmento` - era o fallback que a tela fazia em memoria.
  const or = findCall(calls, (call) => call.type === "or");
  assert.match(or.condition, /profile_id\.eq\.profile-1/);
  assert.match(or.condition, /segmento\.ilike\.Pre infancia/);

  const range = findCall(calls, (call) => call.type === "range");
  assert.deepEqual([range.from, range.to], [50, 99]);

  const orders = calls.filter((call) => call.type === "order").map((call) => call.column);
  assert.deepEqual(orders, ["created_at", "id"], "sem desempate estavel um grupo pode sumir entre paginas");
}

async function testGroupsRepositoryPageDefaults() {
  const { calls, client } = createMockClient([], 0);

  const page = await groupsRepository.searchPage({}, client);

  assert.equal(page.limit, 50, "a tela de Grupos pagina de 50 em 50");
  const range = findCall(calls, (call) => call.type === "range");
  assert.deepEqual([range.from, range.to], [0, 49]);

  const select = findCall(calls, (call) => call.type === "select");
  assert.equal(select.columns, "*", "sem filtro por numero nao ha por que fazer join");

  const { calls: clampCalls, client: clampClient } = createMockClient([], 0);
  const clamped = await groupsRepository.searchPage({ limit: 5000 }, clampClient);
  assert.equal(clamped.limit, 200, "limit pedido pelo cliente nao pode virar uma leitura sem teto");
  assert.deepEqual(
    [findCall(clampCalls, (call) => call.type === "range").from, findCall(clampCalls, (call) => call.type === "range").to],
    [0, 199]
  );
}

async function testGroupsRepositoryStripsEmbeddedJoin() {
  const { client } = createMockClient(
    [{ id: "group-1", nome: "Grupo 1", group_whatsapp_instances: [{ whatsapp_instance_id: "instance-1" }] }],
    1
  );

  const page = await groupsRepository.searchPage({ whatsapp_instance_id: "instance-1" }, client);

  assert.deepEqual(Object.keys(page.rows[0]), ["id", "nome"], "o join existe para filtrar, nao para vazar na resposta");
}

async function testCampaignsRepositoryPage() {
  const { calls, client } = createMockClient([{ id: "campaign-1" }], 84);

  const page = await campaignsRepository.findAllPage({ sort: "desc", offset: 30 }, client);

  assert.equal(page.total, 84);
  assert.equal(page.limit, 30, "a tela de Campanhas pagina de 30 em 30");
  assert.equal(page.offset, 30);

  assert.ok(findCall(calls, (call) => call.type === "is" && call.column === "hidden_at" && call.value === null));

  const range = findCall(calls, (call) => call.type === "range");
  assert.deepEqual([range.from, range.to], [30, 59]);

  // A cascata reproduz a chave que a tela montava em memoria: dia do envio
  // (preenchido em toda campanha), depois o instante da janela, depois o horario
  // das campanhas antigas que nao tem janela.
  const orders = calls.filter((call) => call.type === "order");
  assert.deepEqual(
    orders.map((call) => call.column),
    ["data_envio", "window_start", "horario_envio", "id"]
  );
  orders.slice(0, 3).forEach((call) => {
    assert.equal(call.options.ascending, false);
    assert.equal(call.options.nullsFirst, false, "campanha sem periodo fica no fim nos dois sentidos");
  });

  const { calls: ascCalls, client: ascClient } = createMockClient([], 0);
  await campaignsRepository.findAllPage({}, ascClient);
  assert.equal(
    ascCalls.filter((call) => call.type === "order")[0].options.ascending,
    true,
    "sem `sort` a ordem e' crescente, como o botao da tela comeca"
  );
}

async function testGroupsServicePage() {
  const service = createGroupsService({
    repository: {
      searchPage: async () => ({
        rows: [{ id: "group-1" }, { id: "group-2" }],
        total: 5,
        limit: 2,
        offset: 0,
      }),
    },
    groupWhatsappInstancesRepository: {
      listInstanceIdsByGroupIds: async () => new Map([["group-1", new Set(["instance-1"])]]),
    },
    groupProfilesRepository: { findAll: async () => [] },
  });

  const page = await service.searchPage({ limit: 2 });

  assert.deepEqual(page.data[0].whatsapp_instance_ids, ["instance-1"]);
  assert.deepEqual(page.data[1].whatsapp_instance_ids, []);
  assert.deepEqual(page.pagination, { total: 5, limit: 2, offset: 0, has_more: true });

  const lastPage = createGroupsService({
    repository: {
      searchPage: async () => ({ rows: [{ id: "group-5" }], total: 5, limit: 2, offset: 4 }),
    },
    groupWhatsappInstancesRepository: { listInstanceIdsByGroupIds: async () => new Map() },
    groupProfilesRepository: { findAll: async () => [] },
  });

  assert.equal((await lastPage.searchPage({ limit: 2, offset: 4 })).pagination.has_more, false);
}

async function testGroupsServiceResolvesProfileNome() {
  let receivedParams = null;
  const service = createGroupsService({
    repository: {
      searchPage: async (params) => {
        receivedParams = params;
        return { rows: [], total: 0, limit: 50, offset: 0 };
      },
    },
    groupWhatsappInstancesRepository: { listInstanceIdsByGroupIds: async () => new Map() },
    groupProfilesRepository: {
      findAll: async () => [{ id: "profile-1", nome: "Pre infancia" }],
    },
  });

  await service.searchPage({ profile_id: "profile-1" });

  assert.equal(
    receivedParams.profile_nome,
    "Pre infancia",
    "o nome do perfil viaja junto para o banco resgatar grupo legado sem profile_id"
  );
}

async function testGroupsServiceFacets() {
  const service = createGroupsService({
    repository: {
      countAll: async () => 137,
      listDistinctSetores: async () => ["Comercial", "Financeiro"],
    },
    whatsappInstancesRepository: {
      findAll: async () => [{ id: "instance-1" }, { id: "instance-2" }],
    },
    groupWhatsappInstancesRepository: {
      countGroupsByInstance: async () => new Map([["instance-1", 90]]),
    },
    groupProfilesRepository: { findAll: async () => [] },
  });

  const facets = await service.getFacets();

  assert.equal(facets.total, 137);
  assert.deepEqual(facets.setores, ["Comercial", "Financeiro"]);
  assert.deepEqual(facets.counts_by_instance, { todos: 137, "instance-1": 90, "instance-2": 0 });
}

async function testCampaignsServicePage() {
  const summarizedCampaignIds = [];
  const service = createCampaignsService({
    repository: {
      findAllPage: async () => ({ rows: [{ id: "campaign-1" }], total: 61, limit: 30, offset: 30 }),
    },
    campaignGroupsRepository: {
      listGroups: async (campaignId) => {
        summarizedCampaignIds.push(campaignId);
        return [{ campaign_id: campaignId, group_id: "group-1" }];
      },
      isCampaignFullyTerminal: async () => true,
    },
    dispatchLogsRepository: {
      listResponsibleUsersByCampaigns: async () => [],
    },
    appUsersRepository: { findByIds: async () => [] },
  });

  const page = await service.listPageWithSummary({ limit: 30, offset: 30 });

  assert.equal(page.data.length, 1);
  assert.equal(page.data[0].status, "concluido");
  assert.equal(page.data[0].grupos_total, 1);
  assert.deepEqual(page.pagination, { total: 61, limit: 30, offset: 30, has_more: true });
  assert.deepEqual(
    summarizedCampaignIds,
    ["campaign-1"],
    "o resumo custa consultas por campanha: so as da pagina pedida podem paga-lo"
  );
}

async function testHttpContract() {
  const app = createApp({
    authGate: { enabled: false },
    groupService: {
      search: async () => [{ id: "group-array" }],
      searchPage: async (query) => ({
        data: [{ id: "group-page" }],
        pagination: { total: 137, limit: Number(query.limit), offset: Number(query.offset), has_more: true },
      }),
      getFacets: async () => ({ total: 137, setores: ["Comercial"], counts_by_instance: { todos: 137 } }),
    },
    campaignService: {
      listWithSummary: async () => [{ id: "campaign-array" }],
      listPageWithSummary: async (options) => ({
        data: [{ id: "campaign-page" }],
        pagination: { total: 61, limit: Number(options.limit), offset: Number(options.offset), has_more: true },
      }),
    },
  });

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const { port } = server.address();

  try {
    // Sem limit/offset o formato antigo (array) e' preservado: sete outras telas
    // consomem estas mesmas rotas sem paginar.
    const groupsArray = await (await fetch(`http://127.0.0.1:${port}/groups/search`)).json();
    assert.ok(Array.isArray(groupsArray));
    assert.equal(groupsArray[0].id, "group-array");

    const campaignsArray = await (await fetch(`http://127.0.0.1:${port}/campaigns`)).json();
    assert.ok(Array.isArray(campaignsArray));
    assert.equal(campaignsArray[0].id, "campaign-array");

    const groupsPage = await (await fetch(`http://127.0.0.1:${port}/groups/search?limit=50&offset=50`)).json();
    assert.equal(groupsPage.data[0].id, "group-page");
    assert.deepEqual(groupsPage.pagination, { total: 137, limit: 50, offset: 50, has_more: true });

    const facets = await (await fetch(`http://127.0.0.1:${port}/groups/facets`)).json();
    assert.equal(facets.total, 137);
    assert.deepEqual(facets.setores, ["Comercial"]);

    const campaignsPage = await (await fetch(`http://127.0.0.1:${port}/campaigns?limit=30&offset=30&sort=desc`)).json();
    assert.equal(campaignsPage.data[0].id, "campaign-page");
    assert.deepEqual(campaignsPage.pagination, { total: 61, limit: 30, offset: 30, has_more: true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testPagesUseServerPagination() {
  const fs = require("node:fs");

  const grupos = fs.readFileSync("public/app/grupos.html", "utf8");
  assert.match(grupos, /const PAGE_SIZE = 50;/);
  assert.match(grupos, /params\.set\("offset", String\(\(state\.currentPage - 1\) \* PAGE_SIZE\)\)/);
  assert.doesNotMatch(grupos, /function matchesFilters/, "filtrar no cliente sobre a pagina recortada mostraria menos que 50");

  const campanhas = fs.readFileSync("public/app/campanhas.html", "utf8");
  assert.match(campanhas, /const PAGE_SIZE = 30;/);
  assert.match(campanhas, /params\.set\("sort", state\.sortDirection\)/);
  assert.doesNotMatch(campanhas, /function sortedCampaigns/, "ordenar no cliente so reordenaria a pagina exibida");
}

async function main() {
  await testGroupsRepositoryPage();
  await testGroupsRepositoryPageDefaults();
  await testGroupsRepositoryStripsEmbeddedJoin();
  await testCampaignsRepositoryPage();
  await testGroupsServicePage();
  await testGroupsServiceResolvesProfileNome();
  await testGroupsServiceFacets();
  await testCampaignsServicePage();
  await testHttpContract();
  await testPagesUseServerPagination();

  console.log("listing pagination tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
