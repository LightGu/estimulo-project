/*
  Regressao: as checagens de "campanha pausada/cancelada" que rodam imediatamente
  antes do envio consultavam o banco com `.catch(() => null)`. Um erro transitorio
  do Supabase virava "campanha nao encontrada", a trava nao disparava e o video /
  a mensagem de uma campanha PAUSADA saia para o grupo de WhatsApp, sem log.

  Estes testes fixam o comportamento correto: falha de CONSULTA nao pode ser
  confundida com "campanha liberada". O job deve falhar (recuperavel pelo sweep
  de retry) em vez de enviar.
*/
const assert = require("node:assert/strict");

const { buildDispatchJobData, createDispatchProcessor } = require("../src/queues/dispatch");
const { createMensagensDispatchProcessor } = require("../src/queues/mensagens-dispatch");

const silentLogger = { info() {}, warn() {}, error() {} };

const CAMPAIGN_UUID = "11111111-1111-1111-8111-111111111111";
const GROUP_UUID = "22222222-2222-1222-8222-222222222222";

function createFakeJob(data, id = "job-1") {
  return {
    id,
    data,
    async updateData(nextData) {
      this.data = nextData;
    },
  };
}

// Caminho SEM dispatch-consistency: campaign_id e' UUID mas o video nao, entao
// canUseDispatchConsistency devolve false e a checagem de status refeita em
// dispatch.js e' a unica trava que resta.
async function testVideoNaoSaiQuandoConsultaDeCampanhaFalha() {
  const sent = [];

  const processor = createDispatchProcessor({
    sender: async (payload) => {
      sent.push(payload);
      return { status: 200, data: { key: { id: "msg-1" }, success: true } };
    },
    confirmDelivery: async () => ({ confirmed: true }),
    dispatchLogs: {
      listByCampaign: async () => [],
      createLog: async (payload) => ({ id: "log-1", ...payload }),
      cancelIfPending: async () => ({ id: "log-1", status: "cancelado" }),
      claimForSend: async (id) => ({ id, status: "processando" }),
      updateStatus: async () => ({}),
      updateProviderDelivery: async () => ({}),
    },
    dispatchConsistencyService: null,
    campaignsRepository: {
      findById: async () => {
        throw new Error("supabase indisponivel");
      },
    },
    campaignGroupsRepository: { isCampaignFullyTerminal: async () => false },
    notificationsService: {
      notifyDispatchFailure: async () => ({ sent: true }),
      notifyCampaignFinished: async () => ({ sent: true }),
    },
    inAppNotificationsService: { notifyTrailFinished: async () => ({ sent: true }) },
    progressRepository: {
      hasDuplicate: async () => false,
      registerDelivery: async (payload) => ({ id: "progress-1", ...payload }),
      listDelivered: async () => [],
    },
    groupsRepository: { findById: async () => ({ id: GROUP_UUID, nome: "Grupo" }), update: async () => ({}) },
    logger: silentLogger,
  });

  const jobData = buildDispatchJobData({
    campaign_id: CAMPAIGN_UUID,
    group_id: "120363000000000000@g.us",
    progress_group_id: GROUP_UUID,
    link_video: "https://exemplo/video.mp4",
    scheduled_at: new Date().toISOString(),
  });

  await assert.rejects(
    () => processor(createFakeJob(jobData)),
    /status da campanha/i,
    "a falha de consulta deve derrubar o job, nao liberar o envio"
  );

  assert.equal(sent.length, 0, "nenhuma mensagem pode ter sido enviada ao provedor");
}

// Mesmo principio na fila de mensagem pontual: numa pausa o log continua
// "pendente" de proposito, entao o claim atomico nao barra nada - esta checagem
// e' a unica que para o envio.
async function testMensagemNaoSaiQuandoConsultaDePausaFalha() {
  const sent = [];

  const processor = createMensagensDispatchProcessor({
    sender: async (payload) => {
      sent.push(payload);
      return { status: 200, data: { key: { id: "msg-1" }, success: true } };
    },
    confirmDelivery: async () => ({ confirmed: true }),
    dispatchLogs: {
      findById: async () => {
        throw new Error("supabase indisponivel");
      },
      cancelIfPending: async () => ({ id: "log-1", status: "cancelado" }),
      claimForSend: async (id) => ({ id, status: "processando" }),
      updateStatus: async () => ({}),
      updateProviderDelivery: async () => ({}),
    },
    campaignsRepository: { findById: async () => ({ id: CAMPAIGN_UUID, status: "pausado" }) },
    logger: silentLogger,
  });

  const job = createFakeJob({
    dispatch_log_id: "log-1",
    group_id: "120363000000000000@g.us",
    mensagem: "oi",
    scheduled_at: new Date().toISOString(),
  });

  await assert.rejects(
    () => processor(job),
    /campanha esta pausada/i,
    "a falha de consulta deve derrubar o job, nao liberar o envio"
  );

  assert.equal(sent.length, 0, "nenhuma mensagem pode ter sido enviada ao provedor");
}

async function main() {
  await testVideoNaoSaiQuandoConsultaDeCampanhaFalha();
  await testMensagemNaoSaiQuandoConsultaDePausaFalha();
  console.log("dispatch fail-closed tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
