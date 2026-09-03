const assert = require("node:assert/strict");

const {
  DEFAULT_MAX_ABSOLUTE_DISPATCH_DELAY_MS,
  DEFAULT_MAX_DISPATCH_DELAY_MS,
  resolveStaleDispatchReason,
} = require("../src/services/dispatch-staleness");
const { createDispatchConsistencyService } = require("../src/services/dispatch-consistency.service");
const { createMensagensDispatchProcessor } = require("../src/queues/mensagens-dispatch");

const CONFIRMED_DELIVERY = async () => ({
  confirmed: true,
  verified: true,
  provider_message_id: "3EB0OK",
  provider_status: "SERVER_ACK",
});

// A regra pura: 30 min de atraso (o teto padrao) ainda passa, 30 min e um
// segundo ja cancela. E o limite exato que o bug relatado pedia.
function testResolveStaleDispatchReasonBoundary() {
  const scheduledAt = "2026-08-21T12:00:00.000Z";
  const now = () => new Date(new Date(scheduledAt).getTime() + DEFAULT_MAX_DISPATCH_DELAY_MS);

  assert.equal(resolveStaleDispatchReason(scheduledAt, { now }), null);

  const nowPastLimit = () => new Date(new Date(scheduledAt).getTime() + DEFAULT_MAX_DISPATCH_DELAY_MS + 1000);
  const reason = resolveStaleDispatchReason(scheduledAt, { now: nowPastLimit });

  assert.ok(reason, "deve retornar motivo quando o atraso ultrapassa o teto");
  assert.match(reason, /cancelado/);
}

function testResolveStaleDispatchReasonIgnoresMissingOrInvalidSchedule() {
  assert.equal(resolveStaleDispatchReason(null), null);
  assert.equal(resolveStaleDispatchReason(undefined), null);
  assert.equal(resolveStaleDispatchReason("data-invalida"), null);
}

function testResolveStaleDispatchReasonRespectsCustomMaxDelay() {
  const scheduledAt = "2026-08-21T12:00:00.000Z";
  const now = () => new Date(new Date(scheduledAt).getTime() + 10 * 60 * 1000 + 1);

  assert.ok(resolveStaleDispatchReason(scheduledAt, { maxDelayMs: 5 * 60 * 1000, now }));
  assert.equal(resolveStaleDispatchReason(scheduledAt, { maxDelayMs: 60 * 60 * 1000, now }), null);
}

// Caminho pontual (mensagens-dispatch.js): job que so roda 31 min depois do
// horario planejado nao pode sair - e o cenario relatado no bug.
async function testMensagensDispatchWorkerCancelsStaleJob() {
  const sent = [];
  const logUpdates = [];

  const processor = createMensagensDispatchProcessor({
    sender: async (params) => {
      sent.push(params);
      return { status: 201, data: { key: { id: "3EB0OK" }, status: "PENDING" } };
    },
    dispatchLogs: {
      async cancelIfPending(id, mensagemErro) {
        logUpdates.push({ id, status: "cancelado", mensagemErro });
        return { id, status: "cancelado" };
      },
      async updateStatus(id, status, mensagemErro) {
        logUpdates.push({ id, status, mensagemErro });
      },
      async findById() {
        return { id: "log-1", campaign_id: null };
      },
    },
    campaignsRepository: { async findById() { return null; } },
    now: () => new Date("2026-08-21T12:31:01.000Z"),
    logger: { info() {}, warn() {}, error() {} },
  });

  const job = {
    id: "job-1",
    data: {
      group_id: "120@g.us",
      message: "oi",
      dispatch_log_id: "log-1",
      scheduled_at: "2026-08-21T12:00:00.000Z",
    },
    async updateData(next) {
      this.data = next;
    },
  };

  const result = await processor(job);

  assert.equal(result.status, "cancelado");
  assert.equal(sent.length, 0, "mensagem atrasada nao pode ser enviada");
  assert.equal(logUpdates.length, 1);
  assert.equal(logUpdates[0].status, "cancelado");
  assert.match(logUpdates[0].mensagemErro, /cancelado/);
  assert.equal(job.data.status, "cancelado");
}

// Dentro dos 30 min: comportamento inalterado, mensagem sai normalmente.
async function testMensagensDispatchWorkerSendsWhenWithinDelay() {
  const sent = [];

  const processor = createMensagensDispatchProcessor({
    sender: async (params) => {
      sent.push(params);
      return { status: 201, data: { key: { id: "3EB0OK" }, status: "PENDING" } };
    },
    dispatchLogs: {
      async updateStatus() {},
      async updateProviderDelivery() {},
    },
    campaignsRepository: { async listActiveOverlappingWindow() { return []; } },
    confirmDelivery: CONFIRMED_DELIVERY,
    now: () => new Date("2026-08-21T12:10:00.000Z"),
    logger: { info() {}, warn() {}, error() {} },
  });

  const job = {
    id: "job-2",
    data: {
      group_id: "120@g.us",
      message: "oi",
      scheduled_at: "2026-08-21T12:00:00.000Z",
    },
    async updateData(next) {
      this.data = next;
    },
  };

  const result = await processor(job);

  assert.equal(result.status, "sent");
  assert.equal(sent.length, 1);
}

// Caminho de video (dispatch-consistency.service.js): mesmo cenario, mas para
// campanha de trilha/video. O log existente com horario_envio_planejado
// vencido ha mais de 30 min deve ser cancelado sem chamar o sender.
async function testDispatchConsistencyCancelsStaleVideoLog() {
  const sent = [];
  const logs = [
    {
      id: "log-1",
      campaign_id: "campaign-1",
      group_id: "group-1",
      video_id: "video-1",
      status: "pendente",
      horario_envio_planejado: "2026-08-21T12:00:00.000Z",
    },
  ];

  const dispatchLogsRepository = {
    async listByCampaign() {
      return logs;
    },
    async cancelIfPending(id, mensagemErro) {
      const record = logs.find((entry) => entry.id === id && entry.status === "pendente");

      if (!record) {
        return null;
      }

      record.status = "cancelado";
      record.mensagem_erro = mensagemErro;
      return record;
    },
    async claimForSend(id) {
      const record = logs.find((entry) => entry.id === id && entry.status === "pendente");

      if (!record) {
        return null;
      }

      record.status = "processando";
      return record;
    },
    async updateStatus(id, status, mensagemErro = null) {
      const record = logs.find((entry) => entry.id === id);

      if (record) {
        record.status = status;
        record.mensagem_erro = mensagemErro;
      }

      return record;
    },
  };

  const service = createDispatchConsistencyService({
    dispatchLogsRepository,
    campaignsRepository: { async findById(id) { return { id, status: "programado" }; } },
    groupsRepository: { async findById(id) { return { id }; } },
    videoCatalogRepository: { async findById(id) { return { id }; } },
    logger: { info() {}, warn() {}, error() {} },
  });

  const result = await service.executeDispatch({
    campaignId: "campaign-1",
    groupId: "group-1",
    videoId: "video-1",
    sender: async (payload) => {
      sent.push(payload);
      return { status: 201, data: { key: { id: "x" } } };
    },
  });

  assert.equal(result.status, "cancelado");
  assert.equal(result.skippedSend, true);
  assert.equal(sent.length, 0, "video atrasado nao pode ser enviado");
  assert.equal(logs[0].status, "cancelado");
  assert.match(logs[0].mensagem_erro, /cancelado/);
}

// Regressao do incidente de 02/09/2026: um disparo pontual legitimo, criado
// pelo operador, foi CANCELADO sozinho porque a fila ficou parada e o job so
// rodou depois dos 30 min. Enquanto a janela escolhida nao termina, entregar
// continua sendo exatamente o que foi pedido - o atraso da fila e operacional,
// nao um motivo para descartar o envio.
function testDentroDaJanelaNaoCancelaMesmoAtrasado() {
  const scheduledAt = "2026-09-03T15:01:00.000Z";
  const windowEnd = "2026-09-03T16:30:00.000Z";
  const atrasoDe80Min = () => new Date("2026-09-03T16:21:00.000Z");

  // Sem janela, o teto de 30 min continua valendo exatamente como antes.
  assert.ok(
    resolveStaleDispatchReason(scheduledAt, { now: atrasoDe80Min }),
    "sem janela, 80 min de atraso continua cancelando"
  );
  assert.equal(
    resolveStaleDispatchReason(scheduledAt, { now: atrasoDe80Min, windowEnd }),
    null,
    "dentro da janela o envio nao pode ser cancelado por atraso de fila"
  );
}

// A trava so existe por causa do replay de boot (jobs de dias atras promovidos
// de uma vez quando a infra sobe). A regra de janela nao pode reabrir isso.
function testJanelaEncerradaOuAntigaAindaCancela() {
  const scheduledAt = "2026-09-03T15:01:00.000Z";
  const windowEnd = "2026-09-03T16:30:00.000Z";

  const umMinutoDepoisDoFim = () => new Date("2026-09-03T16:31:00.000Z");
  const reasonForaDaJanela = resolveStaleDispatchReason(scheduledAt, {
    now: umMinutoDepoisDoFim,
    windowEnd,
  });

  assert.ok(reasonForaDaJanela, "passou do fim da janela: nao ha mais envio a fazer");
  assert.match(reasonForaDaJanela, /janela de envio terminou/);

  // Janela mal preenchida (fim daqui a uma semana) nao pode autorizar um job de
  // dias atras: o teto absoluto corta por cima.
  const tresDiasDepois = () => new Date(new Date(scheduledAt).getTime() + 3 * 24 * 60 * 60 * 1000);

  assert.ok(
    resolveStaleDispatchReason(scheduledAt, {
      now: tresDiasDepois,
      windowEnd: "2026-09-10T00:00:00.000Z",
    }),
    "teto absoluto barra replay de boot mesmo com janela aberta"
  );
  assert.ok(
    DEFAULT_MAX_ABSOLUTE_DISPATCH_DELAY_MS < 3 * 24 * 60 * 60 * 1000,
    "o teto absoluto precisa ser menor que o atraso do cenario de replay"
  );
}

async function main() {
  testResolveStaleDispatchReasonBoundary();
  testDentroDaJanelaNaoCancelaMesmoAtrasado();
  testJanelaEncerradaOuAntigaAindaCancela();
  testResolveStaleDispatchReasonIgnoresMissingOrInvalidSchedule();
  testResolveStaleDispatchReasonRespectsCustomMaxDelay();
  await testMensagensDispatchWorkerCancelsStaleJob();
  await testMensagensDispatchWorkerSendsWhenWithinDelay();
  await testDispatchConsistencyCancelsStaleVideoLog();

  console.log("dispatch-staleness tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
