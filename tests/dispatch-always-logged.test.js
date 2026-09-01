/*
  Regressao: TODO envio precisa ficar registrado no relatorio operacional.

  Existiam tres caminhos que entregavam a mensagem no WhatsApp e nao gravavam
  nenhuma linha em `logs` - o disparo chegava no grupo e sumia do relatorio:

  1. dispatchAdHoc (POST /mensagens/dispatch) so gravava log dentro de
     `if (payload.persist_as_campaign)`. Como somente a tela mensagens.html
     envia essa flag, qualquer outro cliente da API enviava sem registrar.
  2. scheduleAdHoc (envio pontual agendado) so criava os logs pendentes quando
     a campanha ad-hoc era persistida - mesma flag, mesmo buraco.
  3. O ramo legado de queues/dispatch.js (usado quando campaign/group/video nao
     sao todos UUID, caso do "Enviar teste para este grupo") enviava o video e
     nunca tocava na tabela de logs.

  Estes testes fixam que os tres caminhos registram o envio.
*/
const assert = require("node:assert/strict");

const { createMensagensService } = require("../src/services/mensagens.service");
const { createDispatchProcessor } = require("../src/queues/dispatch");

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";

function buildMensagensHarness() {
  const createdLogs = [];
  const createdCampaigns = [];
  const enqueued = [];

  const service = createMensagensService({
    groupsRepository: {
      async findById(id) {
        return {
          id,
          nome: `Grupo ${id}`,
          evolution_group_id: `${id}@g.us`,
          segmento: "aviso",
          organization_id: "org-1",
        };
      },
    },
    campaignsRepository: {
      async create(payload) {
        const campaign = { id: `campaign-${createdCampaigns.length + 1}`, ...payload };
        createdCampaigns.push(campaign);
        return campaign;
      },
      async listActiveOverlappingWindow() {
        return [];
      },
    },
    campaignGroupsRepository: {
      async associateGroup() {
        return {};
      },
      async listGroups() {
        return [];
      },
    },
    dispatchLogsRepository: {
      async createLog(payload) {
        const log = { id: `log-${createdLogs.length + 1}`, ...payload };
        createdLogs.push(log);
        return log;
      },
      async updateProviderDelivery() {
        return {};
      },
      async updateDispatchJobId() {
        return {};
      },
    },
    whatsappInstancesRepository: {
      async listActive() {
        return [{ id: "instance-1", instance_name: "Numero A", priority: 0 }];
      },
    },
    whatsappInstancesService: {
      async listDispatchableInstances() {
        return [{ id: "instance-1", instance_name: "Numero A", priority: 0 }];
      },
      async filterDispatchableGroups(groupIds) {
        return { eligible: groupIds, ineligible: [] };
      },
      async getRotationSettings() {
        return { whatsapp_rotation_group_count: 1 };
      },
    },
    sendToEvolution: async () => ({ status: 201, data: { key: { id: "3EB0TEST" }, status: "PENDING" } }),
    confirmProviderDelivery: async () => ({ confirmed: true }),
    // Sem isto o agendamento tentaria falar com o Redis real.
    addMensagensDispatchJob: async (data) => {
      enqueued.push(data);
      return { id: `job-${enqueued.length}` };
    },
    settingsService: {
      async getSettings() {
        return { timezone: "America/Sao_Paulo" };
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  return { service, createdLogs, createdCampaigns, enqueued };
}

// (1) Disparo imediato SEM persist_as_campaign: antes nao gravava nada.
async function testDispatchAdHocRegistraSemPersistAsCampaign() {
  const { service, createdLogs, createdCampaigns } = buildMensagensHarness();

  const result = await service.dispatchAdHoc({ group_ids: ["group-1"], texto: "oi" });

  assert.equal(result.enviados, 1);
  assert.equal(createdLogs.length, 1, "envio imediato sem a flag precisa gravar log");
  assert.equal(createdLogs[0].group_id, "group-1");
  assert.equal(createdLogs[0].status, "enviado");

  // A campanha ancora existe, mas nasce oculta para nao poluir a tela de
  // campanhas - o log dela segue visivel no relatorio.
  assert.equal(createdCampaigns.length, 1);
  assert.ok(createdCampaigns[0].hidden_at, "campanha ancora precisa nascer oculta sem a flag");
}

// Com a flag, o comportamento anterior e preservado: campanha VISIVEL.
async function testDispatchAdHocComPersistAsCampaignMantemCampanhaVisivel() {
  const { service, createdLogs, createdCampaigns } = buildMensagensHarness();

  await service.dispatchAdHoc({ group_ids: ["group-1"], texto: "oi", persist_as_campaign: true });

  assert.equal(createdLogs.length, 1);
  assert.equal(createdCampaigns.length, 1);
  assert.equal(createdCampaigns[0].hidden_at, null, "com a flag a campanha continua visivel");
}

// (2) Agendamento SEM persist_as_campaign: antes nao criava log pendente.
async function testScheduleAdHocRegistraSemPersistAsCampaign() {
  const { service, createdLogs, createdCampaigns } = buildMensagensHarness();

  const windowStart = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const windowEnd = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();

  await service.scheduleAdHoc({
    group_ids: ["group-1"],
    texto: "agendado",
    window_start: windowStart,
    window_end: windowEnd,
    jitter_delay_min_ms: 60000,
    jitter_delay_max_ms: 300000,
  });

  assert.equal(createdLogs.length, 1, "envio agendado sem a flag precisa criar log pendente");
  assert.equal(createdLogs[0].status, "pendente");
  assert.ok(createdLogs[0].horario_envio_planejado, "log pendente precisa carregar o horario planejado");
  assert.ok(createdCampaigns[0].hidden_at, "campanha ancora do agendamento nasce oculta sem a flag");
}

// (3) Ramo legado do worker de dispatch: enviava o video sem gravar log.
async function testRamoLegadoDoWorkerRegistraEnvio() {
  const createdLogs = [];
  let sent = 0;

  const processor = createDispatchProcessor({
    // Sem dispatchConsistencyService o worker cai no ramo legado, exatamente
    // como acontece com um job cujo campaign_id nao e UUID.
    dispatchConsistencyService: null,
    sender: async () => {
      sent += 1;
      return { status: 200, data: { key: { id: "3EB0TEST" }, success: true } };
    },
    confirmDelivery: async () => ({ confirmed: true }),
    dispatchLogs: {
      async createLog(payload) {
        const log = { id: `log-${createdLogs.length + 1}`, ...payload };
        createdLogs.push(log);
        return log;
      },
      async listByCampaign() {
        return [];
      },
    },
    progressRepository: {
      async hasDuplicate() {
        return false;
      },
      async registerDelivery(payload) {
        return { id: "progress-1", ...payload };
      },
      async listDelivered() {
        return [];
      },
    },
    groupsRepository: {
      async findById(id) {
        return { id, nome: "Grupo", evolution_group_id: "group@g.us", trilha_id: UUID_C };
      },
      async update() {
        return {};
      },
    },
    campaignsRepository: {
      async findById() {
        return { id: UUID_A, ativo: true, status: "programado" };
      },
    },
    campaignGroupsRepository: {
      async isCampaignFullyTerminal() {
        return false;
      },
    },
    notificationsService: {
      async notifyDispatchFailure() {
        return { sent: true };
      },
      async notifyCampaignFinished() {
        return { sent: true };
      },
    },
    inAppNotificationsService: {
      async notifyTrailFinished() {
        return { sent: true };
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  const job = {
    id: "job-1",
    data: {
      campaign_id: UUID_A,
      progress_group_id: UUID_B,
      video_id: UUID_C,
      group_id: "group@g.us",
      link_video: "https://example.com/v.mp4",
      legenda: "teste",
      scheduled_at: new Date().toISOString(),
      whatsapp_instance_id: "instance-1",
    },
    async updateData() {},
  };

  await processor(job);

  assert.equal(sent, 1, "o ramo legado precisa continuar enviando");
  assert.equal(createdLogs.length, 1, "o ramo legado precisa registrar o envio no relatorio");
  assert.equal(createdLogs[0].status, "enviado");
  assert.equal(createdLogs[0].whatsapp_instance_id, "instance-1", "o numero usado precisa ir para o log");
}

async function run() {
  await testDispatchAdHocRegistraSemPersistAsCampaign();
  await testDispatchAdHocComPersistAsCampaignMantemCampanhaVisivel();
  await testScheduleAdHocRegistraSemPersistAsCampaign();
  await testRamoLegadoDoWorkerRegistraEnvio();

  console.log("dispatch-always-logged tests OK");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
