const assert = require("assert");

const { createCampaignsService } = require("../src/services/campaigns.service");
const { createMensagensService } = require("../src/services/mensagens.service");
const { createMensagensDispatchProcessor, buildMensagensJobData } = require("../src/queues/mensagens-dispatch");
const { assertDeliveryConfirmed, extractProviderDelivery } = require("../src/services/delivery-confirmation");

// Relativas ao agora: `scheduleAdHoc` recusa janela no passado, entao datas
// fixas fazem a suite passar a quebrar sozinha depois daquele dia.
const WINDOW_START = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const WINDOW_END = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

// Sem isto os testes de processor caem no repositorio real e vao ao banco so
// para descobrir que nao ha campanha de video em voo.
const NO_VIDEO_CAMPAIGNS = {
  async listActiveOverlappingWindow() {
    return [];
  },
};

// A confirmacao de entrega real consulta o banco da Evolution e espera o ACK.
// Nos testes de fluxo o que importa e o que o processor faz com a resposta, nao
// a consulta em si.
const CONFIRMED_DELIVERY = async (result) => ({
  confirmed: true,
  verified: true,
  provider_message_id: result?.data?.key?.id || null,
  provider_status: "SERVER_ACK",
});

function buildCampaignsServiceHarness(overlapping = []) {
  const created = [];
  const groupsByCampaign = new Map(overlapping.map((item) => [item.campaign.id, item.groupIds]));
  const overlapCalls = [];

  const service = createCampaignsService({
    repository: {
      async listActiveOverlappingWindow(start, end, options) {
        overlapCalls.push({ start, end, options });
        return overlapping.map((item) => item.campaign);
      },
      async create(payload) {
        const campaign = { id: `campaign-${created.length + 1}`, status: "programado", ...payload };
        created.push(campaign);
        return campaign;
      },
      async update(id, payload) {
        return { id, ...payload };
      },
      async findById(id) {
        return created.find((campaign) => campaign.id === id) || null;
      },
    },
    campaignGroupsRepository: {
      async listGroups(campaignId) {
        return (groupsByCampaign.get(campaignId) || []).map((groupId) => ({ group_id: groupId }));
      },
      async associateGroup(campaignId, groupId) {
        return { campaign_id: campaignId, group_id: groupId };
      },
    },
    groupsRepository: {
      async findById(id) {
        return { id, organization_id: "org-1" };
      },
    },
    settingsService: {
      async getScheduleSettings() {
        return { timezone: "America/Sao_Paulo" };
      },
    },
    whatsappInstancesService: {
      async assertGroupsDispatchable() {},
    },
    addCampaignTriggerJob: async () => ({ id: "job-1", name: "trigger-campaign", queueName: "campaign-trigger", data: {} }),
  });

  return { service, created, overlapCalls };
}

async function testConflictBlocksWhenGroupsOverlap() {
  const { service, created } = buildCampaignsServiceHarness([
    {
      campaign: { id: "existing-1", trilha: "Campanha da manha", window_start: WINDOW_START, window_end: WINDOW_END },
      groupIds: ["group-a", "group-z"],
    },
  ]);

  await assert.rejects(
    () =>
      service.createAndQueue({
        group_ids: ["group-a"],
        execution_at: WINDOW_START,
        window_start: WINDOW_START,
        window_end: WINDOW_END,
      }),
    (error) => {
      assert.equal(error.code, "CAMPAIGN_WINDOW_CONFLICT");
      assert.match(error.message, /Campanha da manha/);
      assert.deepEqual(error.conflicts[0].group_ids, ["group-a"]);
      return true;
    }
  );

  // Nada pode ser persistido quando o conflito e detectado.
  assert.equal(created.length, 0);
}

async function testNoConflictWhenGroupsAreDisjoint() {
  const { service, created } = buildCampaignsServiceHarness([
    {
      campaign: { id: "existing-1", trilha: "Outra org", window_start: WINDOW_START, window_end: WINDOW_END },
      groupIds: ["group-x"],
    },
  ]);

  const result = await service.createAndQueue({
    group_ids: ["group-a"],
    execution_at: WINDOW_START,
    window_start: WINDOW_START,
    window_end: WINDOW_END,
  });

  assert.ok(result.campaign.id);
  assert.equal(created.length, 1);
}

// Video x video nos mesmos grupos continua proibido: as duas disputam a
// mesma fila de disparo (dispatch) e resolveriam o "proximo video" do grupo.
async function testConflictBlocksWhenBothAreVideoCampaigns() {
  const { service, created } = buildCampaignsServiceHarness([
    {
      campaign: {
        id: "existing-1",
        trilha: "Campanha de video existente",
        window_start: WINDOW_START,
        window_end: WINDOW_END,
      },
      groupIds: ["group-a"],
    },
  ]);

  await assert.rejects(
    () =>
      service.createAndQueue({
        group_ids: ["group-a"],
        execution_at: WINDOW_START,
        window_start: WINDOW_START,
        window_end: WINDOW_END,
      }),
    (error) => {
      assert.equal(error.code, "CAMPAIGN_WINDOW_CONFLICT");
      return true;
    }
  );

  assert.equal(created.length, 0);
}

// Pontual x campanha de video nos MESMOS grupos e janela agora e permitido:
// cada tipo roda na sua propria fila (mensagens-dispatch x dispatch) e resolve
// seu proprio "proximo" sem disputa - ver docs/evolution-api.md.
async function testNoConflictWhenExistingCampaignIsDifferentQueueType() {
  const { service, created } = buildCampaignsServiceHarness([
    {
      campaign: {
        id: "existing-1",
        tipo: "pontual",
        trilha: "Disparo pontual existente",
        window_start: WINDOW_START,
        window_end: WINDOW_END,
      },
      groupIds: ["group-a"],
    },
  ]);

  const result = await service.createAndQueue({
    group_ids: ["group-a"],
    execution_at: WINDOW_START,
    window_start: WINDOW_START,
    window_end: WINDOW_END,
  });

  assert.ok(result.campaign.id);
  assert.equal(created.length, 1);
}

async function testNoConflictWhenNoOverlappingWindow() {
  const { service, overlapCalls } = buildCampaignsServiceHarness([]);

  const result = await service.createAndQueue({
    group_ids: ["group-a"],
    execution_at: WINDOW_START,
    window_start: WINDOW_START,
    window_end: WINDOW_END,
  });

  assert.ok(result.campaign.id);
  assert.equal(overlapCalls.length, 1);
  assert.equal(overlapCalls[0].start, WINDOW_START);
  assert.equal(overlapCalls[0].end, WINDOW_END);
}

async function testAdHocDispatchDoesNotReportUnconfirmedAsSent() {
  // dispatchAdHoc passou a criar o log como "pendente" ANTES de enviar e a
  // fecha-lo com o desfecho depois (ordem invertida por causa do incidente de
  // 04/09/2026: antes enviava primeiro e, se a gravacao falhasse, as mensagens
  // ficavam entregues sem nenhuma linha em `logs`). A garantia verificada aqui
  // e' a mesma - uma recusa da Evolution nao pode virar "enviado" - mas agora
  // se le no estado FINAL do log, nao no payload de criacao.
  const statuses = [];
  const finalStatuses = [];

  const service = createMensagensService({
    groupsRepository: {
      async findById(id) {
        return { id, nome: "Grupo", evolution_group_id: "120@g.us", segmento: "aviso", organization_id: "org-1" };
      },
    },
    campaignsRepository: {
      async create(payload) { return { id: "campaign-1", ...payload }; },
      async update(id, payload) { return { id, ...payload }; },
    },
    campaignGroupsRepository: { async associateGroup() { return {}; } },
    dispatchLogsRepository: {
      async createLog(payload) {
        statuses.push(payload.status);
        return { id: "log-1" };
      },
      async updateStatus(id, status, mensagemErro) {
        finalStatuses.push({ id, status, mensagemErro });
        return { id, status };
      },
    },
    // 200 com corpo de recusa: a Evolution responde assim quando nao entrega.
    sendToEvolution: async () => ({ status: 200, data: { success: false, message: "instance not connected" } }),
    settingsService: { async getScheduleSettings() { return {}; } },
    logger: { error() {} },
  });

  const result = await service.dispatchAdHoc({
    group_ids: ["group-a"],
    texto: "mensagem",
    persist_as_campaign: true,
  });

  assert.equal(result.enviados, 0);
  assert.equal(result.falhas, 1);
  assert.match(result.results[0].error, /instance not connected/);
  // O log existe desde antes do envio, e por isso nasce pendente.
  assert.deepEqual(statuses, ["pendente"]);
  // E fecha em "falhou", com o motivo real da recusa - nunca "enviado".
  assert.equal(finalStatuses.length, 1);
  assert.equal(finalStatuses[0].status, "falhou");
  assert.match(finalStatuses[0].mensagemErro, /instance not connected/);
}

async function testQueuedAdHocDoesNotReportUnconfirmedAsSent() {
  const statuses = [];
  const processor = createMensagensDispatchProcessor({
    sender: async () => ({ status: 200, data: { error: { message: "grupo inexistente" } } }),
    dispatchLogs: {
      async updateStatus(id, status, mensagemErro) {
        statuses.push({ status, mensagemErro });
      },
    },
    campaignsRepository: NO_VIDEO_CAMPAIGNS,
    logger: { info() {}, warn() {}, error() {} },
  });

  const job = {
    id: "job-1",
    data: {
      group_id: "120@g.us",
      message: "oi",
      dispatch_log_id: "log-1",
      // Em producao buildMensagensJobData sempre preenche scheduled_at, e o
      // worker cancela sem enviar o job que chega sem horario (trava de atraso
      // que falha fechado). Sem este campo o teste cancelaria antes de exercitar
      // a recusa da Evolution, que e o que ele quer verificar.
      scheduled_at: new Date().toISOString(),
    },
    async updateData(next) {
      this.data = next;
    },
  };

  await assert.rejects(() => processor(job), /grupo inexistente/);
  assert.deepEqual(
    statuses.map((entry) => entry.status),
    ["processando", "falhou"]
  );
}

function testAssertDeliveryConfirmedAcceptsRealSuccess() {
  assert.doesNotThrow(() => assertDeliveryConfirmed({ status: 201, data: { key: { id: "abc" } } }));
  assert.throws(() => assertDeliveryConfirmed(null), /nao confirmado/);
  assert.throws(() => assertDeliveryConfirmed({ status: 404, data: {} }), /status 404/);
}

// PENDING e a resposta normal de um envio aceito pela Evolution, nao uma recusa:
// reprova-lo derrubaria todo disparo. Ele deve passar e ser registrado.
function testPendingIsAcceptedAndCaptured() {
  const accepted = { status: 201, data: { key: { id: "3EB0ABC" }, status: "PENDING" } };

  assert.doesNotThrow(() => assertDeliveryConfirmed(accepted));
  assert.deepEqual(extractProviderDelivery(accepted), {
    provider_message_id: "3EB0ABC",
    provider_status: "PENDING",
  });
  assert.deepEqual(extractProviderDelivery({ status: 200, data: {} }), {
    provider_message_id: null,
    provider_status: null,
  });
}

function buildScheduleAdHocHarness(overrides = {}) {
  const created = [];
  const enqueued = [];
  const logs = [];
  const providerDeliveries = [];
  // Deposito de anexo em memoria. O anexo deixou de viajar dentro do job e
  // passou pelo spool (src/services/media-spool.js); sem substituir isto aqui, o
  // teste abriria conexao com o Redis de verdade - e como a conexao do projeto
  // usa `maxRetriesPerRequest: null`, ele ficaria esperando para sempre em vez
  // de falhar.
  const spooled = new Map();

  const service = createMensagensService({
    putMediaInSpool: async (content, options = {}) => {
      const spoolKey = `spool-${spooled.size + 1}`;
      spooled.set(spoolKey, content);

      return {
        spool_key: spoolKey,
        mime_type: content.mimeType || null,
        file_name: content.fileName || null,
        type: content.type || null,
        base64_bytes: content.base64.length,
        consumers: options.consumers,
      };
    },
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
        const campaign = { id: `campaign-${created.length + 1}`, ...payload };
        created.push(campaign);
        return campaign;
      },
      async listActiveOverlappingWindow() {
        return overrides.overlapping || [];
      },
    },
    campaignGroupsRepository: {
      async associateGroup() {
        return {};
      },
      async listGroups(campaignId) {
        return (overrides.groupsByCampaign && overrides.groupsByCampaign[campaignId]) || [];
      },
    },
    dispatchLogsRepository: {
      async createLog(payload) {
        logs.push(payload);
        return { id: `log-${logs.length}` };
      },
      async updateProviderDelivery(id, delivery) {
        providerDeliveries.push({ id, delivery });
        return {};
      },
    },
    whatsappInstancesRepository: {
      async listActive() {
        return overrides.instances || [];
      },
    },
    whatsappInstancesService: {
      async filterDispatchableGroups(groupIds) {
        const ineligible = overrides.ineligibleGroupIds || [];
        return { eligible: groupIds.filter((id) => !ineligible.includes(id)), ineligible };
      },
      async getRotationSettings() {
        return { whatsapp_rotation_group_count: overrides.rotationGroupCount || 1 };
      },
    },
    addMensagensDispatchJob: async (params) => {
      enqueued.push(params);
      return { id: `job-${enqueued.length}` };
    },
    settingsService: {
      async getScheduleSettings() {
        return { timezone: "America/Sao_Paulo" };
      },
    },
    sendToEvolution: overrides.sendToEvolution,
    confirmProviderDelivery: overrides.sendToEvolution ? CONFIRMED_DELIVERY : undefined,
    logger: { error() {} },
  });

  return { service, created, enqueued, logs, providerDeliveries, spooled };
}

// dispatchAdHoc chama sendToEvolution de verdade (faria uma request HTTP real)
// quando o harness nao injeta um substituto - usado nos testes que exercitam
// dispatchAdHoc (nao scheduleAdHoc, que so enfileira e nunca chama send).
const CONFIRMED_SEND = async () => ({ status: 201, data: { key: { id: "3EB0MEDIA" }, status: "PENDING" } });

const SCHEDULE_PAYLOAD = {
  group_ids: ["group-a", "group-b"],
  texto: "mensagem",
  window_start: WINDOW_START,
  window_end: WINDOW_END,
  jitter_delay_min_ms: 60000,
  jitter_delay_max_ms: 300000,
  persist_as_campaign: true,
};

async function testScheduledAdHocBlocksWindowConflict() {
  const { service, created, enqueued } = buildScheduleAdHocHarness({
    overlapping: [
      {
        id: "existing-1",
        tipo: "pontual",
        trilha: "Disparo no dia 01/08",
        window_start: WINDOW_START,
        window_end: WINDOW_END,
      },
    ],
    groupsByCampaign: { "existing-1": [{ group_id: "group-b" }] },
  });

  await assert.rejects(
    () => service.scheduleAdHoc(SCHEDULE_PAYLOAD),
    (error) => {
      assert.equal(error.code, "CAMPAIGN_WINDOW_CONFLICT");
      assert.match(error.message, /Disparo no dia 01\/08/);
      assert.deepEqual(error.conflicts[0].group_ids, ["group-b"]);
      return true;
    }
  );

  // Conflito detectado antes de persistir campanha ou enfileirar job.
  assert.equal(created.length, 0);
  assert.equal(enqueued.length, 0);
}

// Pontual agendado por cima da janela de uma campanha de VIDEO existente, nos
// mesmos grupos, e permitido: video roda na fila `dispatch`, pontual roda em
// `mensagens-dispatch` - filas independentes, sem disputa pelo "proximo" do
// grupo.
async function testScheduledAdHocAllowsConflictWithVideoCampaign() {
  const { service, created, enqueued } = buildScheduleAdHocHarness({
    overlapping: [
      {
        id: "existing-1",
        trilha: "Campanha de video em andamento",
        window_start: WINDOW_START,
        window_end: WINDOW_END,
      },
    ],
    groupsByCampaign: { "existing-1": [{ group_id: "group-b" }] },
  });

  const result = await service.scheduleAdHoc(SCHEDULE_PAYLOAD);

  assert.equal(result.scheduled, 2);
  assert.equal(created.length, 1);
  assert.equal(enqueued.length, 2);
}

async function testScheduledAdHocPropagatesInstanceRotation() {
  const { service, enqueued } = buildScheduleAdHocHarness({
    instances: [{ id: "instance-a" }, { id: "instance-b" }],
    rotationGroupCount: 1,
  });

  const result = await service.scheduleAdHoc(SCHEDULE_PAYLOAD);

  assert.equal(result.scheduled, 2);
  // Sem isso o worker cai no numero do .env e ignora o rodizio configurado.
  assert.deepEqual(
    enqueued.map((job) => job.whatsapp_instance_id),
    ["instance-a", "instance-b"]
  );
}

async function testScheduledAdHocRejectsGroupsWithoutInstanceCoverage() {
  const { service, created, enqueued } = buildScheduleAdHocHarness({
    instances: [{ id: "instance-a" }, { id: "instance-b" }],
    ineligibleGroupIds: ["group-b"],
  });

  await assert.rejects(() => service.scheduleAdHoc(SCHEDULE_PAYLOAD), /Grupo\(s\) sem vinculo.*Grupo group-b/);

  assert.equal(created.length, 0);
  assert.equal(enqueued.length, 0);
}

// O job precisa carregar a instancia sorteada; sem o campo em buildMensagensJobData
// ela era descartada silenciosamente entre o agendamento e o worker.
function testMensagensJobDataKeepsInstanceId() {
  const jobData = buildMensagensJobData({
    group_id: "120@g.us",
    message: "oi",
    scheduled_at: WINDOW_START,
    whatsapp_instance_id: "instance-b",
  });

  assert.equal(jobData.whatsapp_instance_id, "instance-b");
  assert.equal(
    buildMensagensJobData({ group_id: "120@g.us", message: "oi", scheduled_at: WINDOW_START }).whatsapp_instance_id,
    null
  );
}

// Disparo pontual com midia anexada (upload): o controller ja resolve o
// arquivo para { base64, mimeType, fileName, type } antes de chegar aqui -
// normalizeContent deve aceitar esse formato direto, sem exigir link/texto,
// e createAdHocCampaign nao pode persistir o base64 em lugar nenhum, so a
// flag possui_midia.
async function testDispatchAdHocWithMediaMarksPossuiMidiaWithoutPersistingFile() {
  const { service, created } = buildScheduleAdHocHarness({ sendToEvolution: CONFIRMED_SEND });

  const result = await service.dispatchAdHoc({
    group_ids: ["group-a"],
    texto: "Convite para o evento",
    content: { base64: "ZmFrZS1pbWFnZQ==", mimeType: "image/png", fileName: "convite.png", type: "image" },
    persist_as_campaign: true,
  });

  assert.equal(result.enviados, 1);
  assert.equal(created.length, 1);
  assert.equal(created[0].possui_midia, true);
  assert.equal(created[0].link_conteudo, null);
  assert.equal(created[0].link_conteudo_tipo, null);
}

async function testScheduleAdHocWithMediaMarksPossuiMidiaWithoutPersistingFile() {
  const { service, created, enqueued, spooled } = buildScheduleAdHocHarness({});

  const result = await service.scheduleAdHoc({
    ...SCHEDULE_PAYLOAD,
    texto: undefined,
    content: { base64: "ZmFrZS12aWRlbw==", mimeType: "video/mp4", fileName: "aviso.mp4", type: "video" },
  });

  assert.equal(result.scheduled, 2);
  assert.equal(created.length, 1);
  assert.equal(created[0].possui_midia, true);
  assert.equal(created[0].link_conteudo, null);
  assert.equal(created[0].link_conteudo_tipo, null);

  /*
    Video com base64 tem o preparo (ffmpeg) e o enfileiramento jogados para
    segundo plano de proposito, para nao segurar a resposta HTTP. A assercao
    anterior deste teste iterava `enqueued` SEM esperar por isso: o array estava
    vazio, e um `every` sobre array vazio e' verdadeiro - ou seja, ela nao
    verificava nada. Aqui a espera e' explicita.
  */
  for (let tentativa = 0; tentativa < 100 && enqueued.length < 2; tentativa += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(enqueued.length, 2, "os dois grupos precisam ter sido enfileirados");

  /*
    O base64 NAO vai mais dentro do job.

    A assercao anterior aqui era o contrario - exigia que cada job carregasse o
    anexo inline. Era o comportamento real, e era o problema: um job por grupo,
    cada um com o arquivo inteiro, e o worker reescrevia esse payload completo a
    cada `job.updateData` (duas ou tres vezes por envio). Um video de 100 MB para
    30 grupos escrevia da ordem de 9 GB no Redis - que roda com appendonly, ou
    seja, gravava o anexo em disco, contrariando na pratica a exigencia de nao
    persistir o arquivo.

    Agora o anexo e' depositado UMA vez e os jobs levam so a referencia. O que
    esta assercao guarda continua sendo o mesmo de antes - o arquivo nao passa
    por dispatchLogs/campaigns -, com o acrescimo de que tambem nao passa pelo
    payload do job.
  */
  assert.equal(spooled.size, 1, "o anexo deve ser depositado uma unica vez para os dois grupos");
  assert.ok(
    enqueued.every((job) => !job.content),
    "nenhum job pode carregar o anexo inline"
  );
  assert.ok(
    enqueued.every((job) => job.content_ref && job.content_ref.file_name === "aviso.mp4"),
    "todo job precisa carregar a referencia do anexo"
  );
  assert.equal(
    new Set(enqueued.map((job) => job.content_ref.spool_key)).size,
    1,
    "os dois grupos precisam apontar para a MESMA entrada"
  );
  assert.equal(enqueued[0].content_ref.consumers, 2, "o contador tem de saber quantos grupos vao ler o anexo");
}

async function testDispatchAdHocWithoutMediaKeepsPossuiMidiaFalse() {
  const { service, created } = buildScheduleAdHocHarness({ sendToEvolution: CONFIRMED_SEND });

  await service.dispatchAdHoc({
    group_ids: ["group-a"],
    texto: "so texto, sem anexo",
    persist_as_campaign: true,
  });

  assert.equal(created.length, 1);
  assert.equal(created[0].possui_midia, false);
}

// Comunicado so com midia (sem legenda) e um caso valido - normalizeContent
// nao pode exigir texto quando ha um anexo.
async function testDispatchAdHocAllowsMediaOnlyWithoutText() {
  const { service } = buildScheduleAdHocHarness({ sendToEvolution: CONFIRMED_SEND });

  const result = await service.dispatchAdHoc({
    group_ids: ["group-a"],
    content: { base64: "ZmFrZS1pbWFnZQ==", mimeType: "image/png", fileName: "aviso.png", type: "image" },
  });

  assert.equal(result.enviados, 1);
}

async function testQueuedAdHocRecordsProviderEvidence() {
  const providerDeliveries = [];
  const processor = createMensagensDispatchProcessor({
    sender: async () => ({ status: 201, data: { key: { id: "3EB0XYZ" }, status: "PENDING" } }),
    dispatchLogs: {
      async updateStatus() {},
      async updateProviderDelivery(id, delivery) {
        providerDeliveries.push({ id, delivery });
      },
    },
    campaignsRepository: NO_VIDEO_CAMPAIGNS,
    confirmDelivery: CONFIRMED_DELIVERY,
    logger: { info() {}, warn() {}, error() {} },
  });

  const job = {
    id: "job-1",
    // scheduled_at obrigatorio: o worker cancela sem enviar o job que chega sem
    // horario (trava de atraso que falha fechado). Em producao
    // buildMensagensJobData sempre preenche este campo.
    data: {
      group_id: "120@g.us",
      message: "oi",
      dispatch_log_id: "log-1",
      scheduled_at: new Date().toISOString(),
    },
    async updateData(next) {
      this.data = next;
    },
  };

  const result = await processor(job);

  assert.equal(result.status, "sent");
  // O que fica no log e o ACK confirmado, nao o "PENDING" do aceite.
  assert.deepEqual(providerDeliveries, [
    { id: "log-1", delivery: { provider_message_id: "3EB0XYZ", provider_status: "SERVER_ACK" } },
  ]);
}

// A evidencia e best-effort: o envio ja aconteceu quando ela e gravada.
async function testProviderEvidenceFailureDoesNotFailTheJob() {
  const processor = createMensagensDispatchProcessor({
    sender: async () => ({ status: 201, data: { key: { id: "3EB0XYZ" } } }),
    dispatchLogs: {
      async updateStatus() {},
      async updateProviderDelivery() {
        throw new Error("coluna inexistente");
      },
    },
    campaignsRepository: NO_VIDEO_CAMPAIGNS,
    confirmDelivery: CONFIRMED_DELIVERY,
    logger: { info() {}, warn() {}, error() {} },
  });

  const job = {
    id: "job-1",
    // scheduled_at obrigatorio: o worker cancela sem enviar o job que chega sem
    // horario (trava de atraso que falha fechado). Em producao
    // buildMensagensJobData sempre preenche este campo.
    data: {
      group_id: "120@g.us",
      message: "oi",
      dispatch_log_id: "log-1",
      scheduled_at: new Date().toISOString(),
    },
    async updateData(next) {
      this.data = next;
    },
  };

  assert.equal((await processor(job)).status, "sent");
}

async function main() {
  await testConflictBlocksWhenGroupsOverlap();
  await testConflictBlocksWhenBothAreVideoCampaigns();
  await testNoConflictWhenExistingCampaignIsDifferentQueueType();
  await testNoConflictWhenGroupsAreDisjoint();
  await testNoConflictWhenNoOverlappingWindow();
  await testAdHocDispatchDoesNotReportUnconfirmedAsSent();
  await testQueuedAdHocDoesNotReportUnconfirmedAsSent();
  testAssertDeliveryConfirmedAcceptsRealSuccess();
  testPendingIsAcceptedAndCaptured();
  await testScheduledAdHocBlocksWindowConflict();
  await testScheduledAdHocAllowsConflictWithVideoCampaign();
  await testScheduledAdHocPropagatesInstanceRotation();
  await testScheduledAdHocRejectsGroupsWithoutInstanceCoverage();
  testMensagensJobDataKeepsInstanceId();
  await testDispatchAdHocWithMediaMarksPossuiMidiaWithoutPersistingFile();
  await testScheduleAdHocWithMediaMarksPossuiMidiaWithoutPersistingFile();
  await testDispatchAdHocWithoutMediaKeepsPossuiMidiaFalse();
  await testDispatchAdHocAllowsMediaOnlyWithoutText();
  await testQueuedAdHocRecordsProviderEvidence();
  await testProviderEvidenceFailureDoesNotFailTheJob();

  console.log("campaign-window-conflict tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
