const assert = require("assert");

const {
  assertNoVideoCampaignInWindow,
  resolveAdHocDispatchBlock,
} = require("../src/services/dispatch-exclusivity");
const { createMensagensDispatchProcessor } = require("../src/queues/mensagens-dispatch");
const { createMensagensService } = require("../src/services/mensagens.service");

const WINDOW_START = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const WINDOW_END = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

function buildCampaignsRepository(campaigns) {
  return {
    async listActiveOverlappingWindow() {
      return campaigns;
    },
  };
}

const CONFIRMED_DELIVERY = async () => ({
  confirmed: true,
  verified: true,
  provider_message_id: "3EB0OK",
  provider_status: "SERVER_ACK",
});

// A regra que faltava: campanha de video e disparo pontual dividem o mesmo
// numero de WhatsApp, entao a janela conflita mesmo sem nenhum grupo em comum.
async function testBlocksWindowSharedWithVideoCampaign() {
  await assert.rejects(
    () =>
      assertNoVideoCampaignInWindow({
        campaignsRepository: buildCampaignsRepository([
          {
            id: "campaign-1",
            tipo: "trilha",
            trilha: "Campanha do dia 03/08",
            window_start: WINDOW_START,
            window_end: WINDOW_END,
          },
        ]),
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        timezone: "America/Sao_Paulo",
      }),
    (error) => {
      assert.equal(error.code, "CAMPAIGN_WINDOW_CONFLICT");
      assert.match(error.message, /Campanha do dia 03\/08/);
      assert.match(error.message, /mesmo numero de WhatsApp/);
      assert.equal(error.conflicts[0].campaign_id, "campaign-1");
      return true;
    }
  );
}

async function testAllowsWindowSharedOnlyWithOtherAdHocCampaign() {
  await assert.doesNotReject(() =>
    assertNoVideoCampaignInWindow({
      campaignsRepository: buildCampaignsRepository([
        { id: "campaign-2", tipo: "pontual", trilha: "Campanha de texto", window_start: WINDOW_START, window_end: WINDOW_END },
      ]),
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    })
  );
}

async function testResolveBlockUsesLatestWindowEnd() {
  const at = new Date("2026-08-03T22:00:00.000Z");
  const block = await resolveAdHocDispatchBlock({
    campaignsRepository: buildCampaignsRepository([
      { id: "c1", tipo: "trilha", trilha: "Primeira", window_start: "2026-08-03T21:40:00.000Z", window_end: "2026-08-03T22:20:00.000Z" },
      { id: "c2", tipo: "trilha", trilha: "Segunda", window_start: "2026-08-03T21:50:00.000Z", window_end: "2026-08-03T22:45:00.000Z" },
    ]),
    at,
    resumeBufferMs: 60000,
  });

  assert.ok(block, "deve bloquear enquanto ha campanha de video em voo");
  assert.equal(block.resumeAt.toISOString(), "2026-08-03T22:46:00.000Z");
  assert.match(block.reason, /Primeira/);
}

async function testResolveBlockReturnsNullWhenClear() {
  const block = await resolveAdHocDispatchBlock({
    campaignsRepository: buildCampaignsRepository([]),
    at: new Date(),
  });

  assert.equal(block, null);
}

// scheduled_at alinhado com o relogio congelado dos testes (`now` injetado).
//
// Em producao buildMensagensJobData SEMPRE preenche scheduled_at, e o worker tem
// uma trava de atraso que falha fechado: job sem horario e cancelado sem enviar
// (resolveJobStaleReason em src/services/dispatch-staleness.js). Um fixture sem
// esse campo nao representa nenhum job real e cancelaria antes de chegar na
// regra de adiamento que estes testes querem exercitar.
const FROZEN_NOW_ISO = "2026-08-03T22:00:00.000Z";

function buildJob(data = {}) {
  return {
    id: "job-1",
    data: {
      group_id: "120@g.us",
      message: "oi",
      dispatch_log_id: "log-1",
      scheduled_at: FROZEN_NOW_ISO,
      ...data,
    },
    async updateData(next) {
      this.data = next;
    },
  };
}

// O ponto central: com campanha de video em andamento o worker reagenda em vez
// de mandar por cima dela.
async function testProcessorPostponesInsteadOfSending() {
  const sent = [];
  const enqueued = [];
  const statuses = [];
  const plannedSchedules = [];

  const processor = createMensagensDispatchProcessor({
    sender: async (params) => {
      sent.push(params);
      return { status: 201, data: { key: { id: "3EB0OK" }, status: "PENDING" } };
    },
    dispatchLogs: {
      async updateStatus(id, status) {
        statuses.push(status);
      },
      async updatePlannedSchedule(id, horario) {
        plannedSchedules.push({ id, horario });
      },
    },
    campaignsRepository: buildCampaignsRepository([
      {
        id: "c1",
        tipo: "trilha",
        trilha: "Campanha do dia 03/08",
        window_start: "2026-08-03T21:40:00.000Z",
        window_end: "2026-08-03T22:20:00.000Z",
      },
    ]),
    enqueue: async (data, options) => {
      enqueued.push({ data, options });
      return { id: "job-2" };
    },
    confirmDelivery: CONFIRMED_DELIVERY,
    now: () => new Date("2026-08-03T22:00:00.000Z"),
    logger: { info() {}, warn() {}, error() {} },
  });

  const result = await processor(buildJob());

  assert.equal(result.status, "postponed");
  assert.equal(result.postponed_count, 1);
  assert.equal(sent.length, 0, "nada pode ser enviado durante a campanha de video");
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].data.scheduled_at, result.resume_at);
  assert.equal(enqueued[0].data.postponed_count, 1);
  // O log volta para "pendente" com o novo horario: o relatorio mostra o
  // adiamento em vez de uma linha parada em "processando".
  assert.deepEqual(statuses, ["pendente"]);
  assert.deepEqual(plannedSchedules, [{ id: "log-1", horario: result.resume_at }]);
}

async function testProcessorFailsAfterTooManyPostponements() {
  const statuses = [];
  const processor = createMensagensDispatchProcessor({
    sender: async () => ({ status: 201, data: { key: { id: "3EB0OK" } } }),
    dispatchLogs: {
      async updateStatus(id, status, mensagemErro) {
        statuses.push({ status, mensagemErro });
      },
    },
    campaignsRepository: buildCampaignsRepository([
      { id: "c1", tipo: "trilha", trilha: "Campanha", window_start: "2026-08-03T21:40:00.000Z", window_end: "2026-08-03T22:20:00.000Z" },
    ]),
    enqueue: async () => ({ id: "job-2" }),
    maxPostponements: 2,
    now: () => new Date("2026-08-03T22:00:00.000Z"),
    logger: { info() {}, warn() {}, error() {} },
  });

  await assert.rejects(() => processor(buildJob({ postponed_count: 2 })), /adiado 2 vezes/);
  assert.equal(statuses[0].status, "falhou");
}

async function testProcessorSendsWhenNoVideoCampaignInFlight() {
  const sent = [];
  const processor = createMensagensDispatchProcessor({
    sender: async (params) => {
      sent.push(params);
      return { status: 201, data: { key: { id: "3EB0OK" }, status: "PENDING" } };
    },
    dispatchLogs: { async updateStatus() {}, async updateProviderDelivery() {} },
    campaignsRepository: buildCampaignsRepository([]),
    confirmDelivery: CONFIRMED_DELIVERY,
    // Relogio congelado igual ao dos outros casos: sem ele o job do fixture
    // (FROZEN_NOW_ISO) e comparado com a data real e a trava de atraso cancela
    // o envio, tornando o teste dependente do calendario.
    now: () => new Date(FROZEN_NOW_ISO),
    logger: { info() {}, warn() {}, error() {} },
  });

  const result = await processor(buildJob());

  assert.equal(result.status, "sent");
  assert.equal(sent.length, 1);
}

// Bloqueio no agendamento: nem chega a criar campanha nem a enfileirar job.
async function testScheduleAdHocRejectsVideoCampaignWindow() {
  const created = [];
  const enqueued = [];

  const service = createMensagensService({
    groupsRepository: {
      async findById(id) {
        return { id, nome: `Grupo ${id}`, evolution_group_id: `${id}@g.us`, segmento: "aviso", organization_id: "org-1" };
      },
    },
    campaignsRepository: {
      async create(payload) {
        created.push(payload);
        return { id: "campaign-nova", ...payload };
      },
      async listActiveOverlappingWindow() {
        return [
          {
            id: "campaign-video",
            tipo: "trilha",
            trilha: "Campanha do dia 03/08",
            window_start: WINDOW_START,
            window_end: WINDOW_END,
          },
        ];
      },
    },
    campaignGroupsRepository: {
      async associateGroup() {
        return {};
      },
      // Nenhum grupo em comum: o bloqueio nao pode depender disso.
      async listGroups() {
        return [];
      },
    },
    dispatchLogsRepository: { async createLog() { return { id: "log-1" }; } },
    whatsappInstancesRepository: { async listActive() { return []; } },
    whatsappInstancesService: {
      async filterDispatchableGroups(groupIds) {
        return { eligible: groupIds, ineligible: [] };
      },
      async getRotationSettings() {
        return { whatsapp_rotation_group_count: 1 };
      },
    },
    addMensagensDispatchJob: async (params) => {
      enqueued.push(params);
      return { id: "job-1" };
    },
    settingsService: { async getScheduleSettings() { return { timezone: "America/Sao_Paulo" }; } },
    logger: { error() {} },
  });

  await assert.rejects(
    () =>
      service.scheduleAdHoc({
        group_ids: ["group-a"],
        texto: "mensagem",
        window_start: WINDOW_START,
        window_end: WINDOW_END,
        persist_as_campaign: true,
      }),
    (error) => {
      assert.equal(error.code, "CAMPAIGN_WINDOW_CONFLICT");
      assert.match(error.message, /campanha de video em andamento/);
      return true;
    }
  );

  assert.equal(created.length, 0);
  assert.equal(enqueued.length, 0);
}

// "Enviar agora" durante campanha de video: bloqueio duro, sem tentar enviar.
async function testDispatchAdHocBlockedWhileVideoCampaignRuns() {
  const sent = [];

  const service = createMensagensService({
    groupsRepository: {
      async findById(id) {
        return { id, nome: "Grupo", evolution_group_id: "120@g.us", segmento: "aviso", organization_id: "org-1" };
      },
    },
    campaignsRepository: {
      async listActiveOverlappingWindow() {
        return [
          {
            id: "campaign-video",
            tipo: "trilha",
            trilha: "Campanha do dia 03/08",
            window_start: new Date(Date.now() - 60000).toISOString(),
            window_end: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
        ];
      },
    },
    campaignGroupsRepository: { async associateGroup() { return {}; } },
    dispatchLogsRepository: { async createLog() { return { id: "log-1" }; } },
    sendToEvolution: async (params) => {
      sent.push(params);
      return { status: 201, data: { key: { id: "x" } } };
    },
    settingsService: { async getScheduleSettings() { return {}; } },
    logger: { error() {} },
  });

  await assert.rejects(
    () => service.dispatchAdHoc({ group_ids: ["group-a"], texto: "mensagem" }),
    (error) => {
      assert.equal(error.code, "CAMPAIGN_WINDOW_CONFLICT");
      assert.match(error.message, /Nao e possivel disparar agora/);
      return true;
    }
  );

  assert.equal(sent.length, 0);
}

async function main() {
  await testBlocksWindowSharedWithVideoCampaign();
  await testAllowsWindowSharedOnlyWithOtherAdHocCampaign();
  await testResolveBlockUsesLatestWindowEnd();
  await testResolveBlockReturnsNullWhenClear();
  await testProcessorPostponesInsteadOfSending();
  await testProcessorFailsAfterTooManyPostponements();
  await testProcessorSendsWhenNoVideoCampaignInFlight();
  await testScheduleAdHocRejectsVideoCampaignWindow();
  await testDispatchAdHocBlockedWhileVideoCampaignRuns();

  console.log("dispatch-exclusivity tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
