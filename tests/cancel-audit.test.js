// Regressao da auditoria de cancelamento.
//
// Origem: em 03/09/2026 uma campanha de texto apareceu no painel com os 34
// grupos "Cancelado" e nao havia como responder quem tinha cancelado. O banco
// guardava so `status = 'cancelado'`; o horario exibido na tela era o da
// CRIACAO do envio (02:34), quase dez horas antes do cancelamento real (12:16).
//
// Os testes abaixo travam as tres pecas que fecham esse buraco:
//   1. todo caminho de cancelamento grava quando/de onde/por quem;
//   2. cancelamento automatico nao inventa um responsavel;
//   3. a tela recebe o instante da ultima alteracao, nao o da criacao.

const assert = require("node:assert/strict");

const dispatchLogsRepository = require("../src/repositories/dispatch-logs.repository");
const { createCampaignsService } = require("../src/services/campaigns.service");

// Mock minimo do supabase-js: guarda o payload do update para inspecao. Os
// metodos encadeaveis devolvem `this` e o builder e thenable, porque
// cancelPendingByCampaign aguarda a query direto (sem .single()).
function createUpdateSpyClient(result = []) {
  const state = { table: null, payload: null, filters: [] };

  const builder = {
    update(payload) {
      state.payload = payload;
      return this;
    },
    select() {
      return this;
    },
    eq(column, value) {
      state.filters.push({ column, value });
      return this;
    },
    maybeSingle() {
      return Promise.resolve({ data: Array.isArray(result) ? result[0] || null : result, error: null });
    },
    then(resolve, reject) {
      return Promise.resolve({ data: result, error: null }).then(resolve, reject);
    },
  };

  return {
    state,
    client: {
      from(table) {
        state.table = table;
        return builder;
      },
    },
  };
}

function assertIsoTimestamp(value, label) {
  assert.ok(value, `${label} precisa ser preenchido`);
  assert.ok(!Number.isNaN(new Date(value).getTime()), `${label} precisa ser uma data valida`);
}

// --- Repositorio -----------------------------------------------------------

async function testCancelPendingByCampaignRecordsWhoCancelled() {
  const { state, client } = createUpdateSpyClient([{ id: "log-1" }]);

  await dispatchLogsRepository.cancelPendingByCampaign(
    "campaign-1",
    { origem: "usuario", usuarioId: "user-42" },
    client
  );

  assert.equal(state.table, "logs");
  assert.equal(state.payload.status, "cancelado");
  assert.equal(state.payload.cancelado_origem, "usuario");
  assert.equal(state.payload.cancelado_por, "user-42", "a cascata precisa carimbar quem cancelou em cada envio");
  assertIsoTimestamp(state.payload.cancelado_em, "cancelado_em");
  assert.ok(
    state.payload.mensagem_erro,
    "sem mensagem, um cancelamento pedido no painel fica visualmente identico a um automatico"
  );
  // So envio ainda pendente pode ser cancelado: um ja enviado nao volta atras.
  assert.deepEqual(
    state.filters.map((filter) => filter.column),
    ["campaign_id", "status"]
  );
  assert.equal(state.filters[1].value, "pendente");
}

async function testCancelPendingByCampaignWithoutUserLeavesNoOwner() {
  const { state, client } = createUpdateSpyClient([{ id: "log-1" }]);

  await dispatchLogsRepository.cancelPendingByCampaign("campaign-1", {}, client);

  assert.equal(state.payload.cancelado_origem, "campanha_cancelada");
  assert.equal(state.payload.cancelado_por, null, "sem usuario na chamada, a coluna fica nula em vez de indefinida");
}

async function testCancelIfPendingDoesNotInventAResponsible() {
  const { state, client } = createUpdateSpyClient({ id: "log-1" });

  // Caminho da trava de atraso (dispatch-staleness): nao ha usuario por tras.
  await dispatchLogsRepository.cancelIfPending("log-1", "Envio cancelado: atraso.", {}, client);

  assert.equal(state.payload.cancelado_origem, "atraso");
  assert.equal(state.payload.cancelado_por, null, "cancelamento automatico nao pode apontar para uma conta");
  assert.equal(state.payload.mensagem_erro, "Envio cancelado: atraso.");
  assertIsoTimestamp(state.payload.cancelado_em, "cancelado_em");
}

// --- Service ---------------------------------------------------------------

function buildServiceHarness(overrides = {}) {
  const campaignsById = new Map((overrides.campaigns || []).map((campaign) => [campaign.id, { ...campaign }]));
  const updates = [];
  const cancelCalls = [];

  const repository = {
    async findById(id) {
      return campaignsById.get(id) || null;
    },
    async findAll() {
      return [...campaignsById.values()];
    },
    async update(id, payload) {
      const next = { ...(campaignsById.get(id) || { id }), ...payload };
      campaignsById.set(id, next);
      updates.push({ id, payload });
      return next;
    },
  };

  const dispatchLogsRepository = {
    async listPendingByCampaign() {
      return overrides.pendingLogs || [];
    },
    async cancelPendingByCampaign(campaignId, options) {
      cancelCalls.push({ campaignId, options });
      return overrides.pendingLogs || [];
    },
    async listByCampaign() {
      return overrides.logs || [];
    },
    async listResponsibleUsersByCampaigns() {
      return overrides.responsibleLogs || [];
    },
  };

  const campaignGroupsRepository = {
    async listGroups() {
      return overrides.groupRows || [];
    },
    async isCampaignFullyTerminal() {
      return false;
    },
  };

  const service = createCampaignsService({
    repository,
    campaignGroupsRepository,
    dispatchLogsRepository,
    appUsersRepository: {
      async findByIds(ids) {
        return (overrides.users || []).filter((user) => ids.includes(user.id));
      },
    },
    settingsService: {
      async getScheduleSettings() {
        return {};
      },
    },
  });

  return { service, updates, cancelCalls };
}

async function testCancelCampaignPersistsTheAuthenticatedUser() {
  const { service, updates, cancelCalls } = buildServiceHarness({
    campaigns: [{ id: "campaign-1", status: "programado" }],
    pendingLogs: [{ id: "log-1", status: "pendente" }],
  });

  await service.cancelCampaign("campaign-1", { usuarioId: "user-42" });

  assert.equal(cancelCalls.length, 1);
  assert.equal(cancelCalls[0].options.origem, "usuario");
  assert.equal(cancelCalls[0].options.usuarioId, "user-42");
  assert.equal(
    updates[updates.length - 1].payload.cancelado_por,
    "user-42",
    "a campanha precisa guardar quem cancelou, nao so o status"
  );
}

// Chamada sem sessao (job, teste, chamada interna) nao pode explodir nem
// atribuir o cancelamento a uma conta qualquer.
async function testCancelCampaignWithoutUserStoresNull() {
  const { service, updates, cancelCalls } = buildServiceHarness({
    campaigns: [{ id: "campaign-1", status: "programado" }],
    pendingLogs: [{ id: "log-1", status: "pendente" }],
  });

  await service.cancelCampaign("campaign-1");

  assert.equal(cancelCalls[0].options.usuarioId, null);
  assert.equal(updates[updates.length - 1].payload.cancelado_por, null);
}

async function testListWithSummaryResolvesCancellerName() {
  const { service } = buildServiceHarness({
    campaigns: [
      { id: "campaign-1", status: "cancelado", cancelado_por: "user-42" },
      { id: "campaign-2", status: "cancelado", cancelado_por: null },
    ],
    users: [{ id: "user-42", username: "sophia@estimulo.org", display_name: "Sophia" }],
  });

  const [cancelledByUser, cancelledBeforeAudit] = await service.listWithSummary();

  assert.equal(cancelledByUser.cancelado_por_nome, "Sophia");
  assert.equal(
    cancelledBeforeAudit.cancelado_por_nome,
    null,
    "campanha cancelada antes da coluna existir fica sem nome em vez de herdar o de outra"
  );
}

// --- Coluna "Atualizado em" ------------------------------------------------

async function testGroupsDetailExposesLastUpdateInsteadOfCreation() {
  const { service } = buildServiceHarness({
    campaigns: [{ id: "campaign-1", status: "cancelado" }],
    groupRows: [{ group_id: "group-1", groups: { nome: "Estimulo BEES #E03" } }],
    logs: [
      {
        id: "log-1",
        group_id: "group-1",
        status: "cancelado",
        criado_em: "2026-09-03T02:34:07.419Z",
        atualizado_em: "2026-09-03T12:16:07.639Z",
      },
    ],
  });

  const [detail] = await service.getGroupsDetail("campaign-1");

  assert.equal(detail.atualizado_em, "2026-09-03T12:16:07.639Z");
  assert.notEqual(
    detail.atualizado_em,
    detail.criado_em,
    "a tela mostrava a criacao do envio como se fosse a hora do cancelamento"
  );
}

// Log anterior ao trigger trg_logs_atualizado_em: a resposta certa e' "nao sei",
// nunca repetir criado_em nesse campo - foi assim que a leitura errada nasceu.
async function testGroupsDetailKeepsUnknownUpdateNull() {
  const { service } = buildServiceHarness({
    campaigns: [{ id: "campaign-1", status: "concluido" }],
    groupRows: [{ group_id: "group-1", groups: { nome: "Estimulo BEES #M23" } }],
    logs: [
      {
        id: "log-1",
        group_id: "group-1",
        status: "enviado",
        criado_em: "2026-08-01T10:00:00.000Z",
      },
    ],
  });

  const [detail] = await service.getGroupsDetail("campaign-1");

  assert.equal(detail.atualizado_em, null);
  assert.equal(detail.criado_em, "2026-08-01T10:00:00.000Z");
}

async function main() {
  await testCancelPendingByCampaignRecordsWhoCancelled();
  await testCancelPendingByCampaignWithoutUserLeavesNoOwner();
  await testCancelIfPendingDoesNotInventAResponsible();
  await testCancelCampaignPersistsTheAuthenticatedUser();
  await testCancelCampaignWithoutUserStoresNull();
  await testListWithSummaryResolvesCancellerName();
  await testGroupsDetailExposesLastUpdateInsteadOfCreation();
  await testGroupsDetailKeepsUnknownUpdateNull();

  console.log("cancel-audit tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
