const assert = require("node:assert/strict");

const { closeQueueInfrastructure } = require("../src/queues/bullmq");
const {
  MAX_RETRIES_PER_SWEEP,
  MAX_RETRY_ATTEMPTS,
  createDispatchFailureRetryProcessor,
} = require("../src/queues/dispatch-failure-retry");

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function minutesAgoIso(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function buildFailedLog(index, overrides = {}) {
  return {
    id: `log-${index}`,
    campaign_id: `campaign-${index}`,
    group_id: `group-${index}`,
    video_id: `video-${index}`,
    retry_count: 0,
    // Falha recente: o sweep so reenfileira log com horario original conhecido
    // (resolveRetryScheduledAt), e o reenvio herda esse horario em vez de ser
    // reestampado com "agora" - e o que permite a trava de atraso barrar um log
    // antigo. Sem este campo o log e pulado de proposito.
    horario_envio_planejado: minutesAgoIso(2),
    groups: { id: `group-${index}`, evolution_group_id: `12036300000000${index}@g.us`, trilha_id: "trilha-1" },
    video_catalog: { id: `video-${index}`, drive_file_id: `drive-${index}` },
    ...overrides,
  };
}

function createDeps(logs, overrides = {}) {
  const listCalls = [];
  const enqueued = [];
  const marked = [];

  return {
    listCalls,
    enqueued,
    marked,
    options: {
      dispatchLogsRepository: {
        listFailedForRetry: async (options) => {
          listCalls.push(options);
          const limit = options && options.limit ? options.limit : logs.length;
          const maxRetryCount =
            options && Number.isFinite(Number(options.max_retry_count))
              ? Number(options.max_retry_count)
              : Infinity;

          return logs.filter((log) => (log.retry_count || 0) < maxRetryCount).slice(0, limit);
        },
        markRetrying: async (id, retryCount) => {
          marked.push({ id, retryCount });
          return { id, retry_count: retryCount };
        },
      },
      groupsRepository: { findById: async () => null },
      settingsService: { getDispatchRulesSettings: async () => ({ auto_retry_failures: true }) },
      enqueueDispatch: async (data) => {
        enqueued.push(data);
      },
      logger: silentLogger,
      ...overrides,
    },
  };
}

// O bug original: a query nao filtrava retry_count nem limitava o resultado,
// entao um backlog inteiro de falhas era reenfileirado num unico sweep e cada
// reenvio que falhava gerava uma notificacao de falha no WhatsApp.
async function testSweepPassesFilterAndLimitToRepository() {
  const logs = Array.from({ length: 100 }, (_, index) => buildFailedLog(index));
  const { listCalls, options } = createDeps(logs);

  await createDispatchFailureRetryProcessor(options)();

  assert.equal(listCalls.length, 1);
  assert.equal(listCalls[0].max_retry_count, MAX_RETRY_ATTEMPTS);
  assert.equal(listCalls[0].limit, MAX_RETRIES_PER_SWEEP);
}

async function testSweepCapsRetriesPerRun() {
  const logs = Array.from({ length: MAX_RETRIES_PER_SWEEP + 40 }, (_, index) => buildFailedLog(index));
  const { enqueued, options } = createDeps(logs);

  const result = await createDispatchFailureRetryProcessor(options)();

  assert.equal(enqueued.length, MAX_RETRIES_PER_SWEEP);
  assert.equal(result.retried, MAX_RETRIES_PER_SWEEP);
}

// Rede de seguranca no processor: mesmo que a query devolva logs que ja
// esgotaram as tentativas, eles nao podem ser reenfileirados.
async function testSweepSkipsExhaustedLogsEvenIfRepositoryReturnsThem() {
  const logs = [
    buildFailedLog(1, { retry_count: MAX_RETRY_ATTEMPTS }),
    buildFailedLog(2, { retry_count: MAX_RETRY_ATTEMPTS + 5 }),
    buildFailedLog(3, { retry_count: 1 }),
  ];
  const { enqueued, options } = createDeps(logs, {
    dispatchLogsRepository: {
      listFailedForRetry: async () => logs,
      markRetrying: async () => ({}),
    },
  });

  const result = await createDispatchFailureRetryProcessor(options)();

  assert.equal(enqueued.length, 1);
  assert.equal(result.retried, 1);
  assert.equal(enqueued[0].campaign_id, "campaign-3");
}

// retry_count precisa chegar ao job de dispatch: o worker usa esse valor para
// notificar a falha apenas na primeira tentativa.
async function testRetryCountIsPropagatedToDispatchJob() {
  const logs = [buildFailedLog(1, { retry_count: 0 })];
  const { enqueued, marked, options } = createDeps(logs);

  await createDispatchFailureRetryProcessor(options)();

  assert.equal(marked[0].retryCount, 1);
  assert.equal(enqueued[0].retry_count, 1);
}

// Falha de "entrega nao confirmada" e a unica em que a mensagem JA saiu: a
// Evolution aceitou e a midia subiu para o WhatsApp. Reenviar duplicaria o video
// no grupo que ja recebeu, e o ACK nao muda (em grupo ele nao existe). Cobre
// tambem os logs falso-negativo gravados antes da correcao da regra de grupo.
async function testSweepSkipsUnconfirmedDeliveryAsPermanent() {
  const logs = [
    buildFailedLog(1, {
      mensagem_erro:
        "Envio aceito pela Evolution, mas o WhatsApp nao confirmou a entrega em 90s (estado no provedor: PENDING).",
    }),
    buildFailedLog(2, { mensagem_erro: "Evolution API respondeu HTTP 500" }),
  ];
  const { enqueued, marked, options } = createDeps(logs);

  const result = await createDispatchFailureRetryProcessor(options)();

  assert.equal(result.skipped_permanent, 1);
  assert.equal(enqueued.length, 1, "so a falha transitoria pode ser reenfileirada");
  assert.equal(enqueued[0].campaign_id, "campaign-2");
  assert.ok(
    !marked.some((entry) => entry.id === "log-1"),
    "log de entrega nao confirmada nao pode voltar para pendente"
  );
}

async function testSweepIsNoOpWhenAutoRetryDisabled() {
  const logs = [buildFailedLog(1)];
  const { enqueued, listCalls, options } = createDeps(logs, {
    settingsService: { getDispatchRulesSettings: async () => ({ auto_retry_failures: false }) },
  });

  const result = await createDispatchFailureRetryProcessor(options)();

  assert.deepEqual(result, { checked: 0, retried: 0 });
  assert.equal(listCalls.length, 0);
  assert.equal(enqueued.length, 0);
}

async function main() {
  await testSweepPassesFilterAndLimitToRepository();
  await testSweepCapsRetriesPerRun();
  await testSweepSkipsExhaustedLogsEvenIfRepositoryReturnsThem();
  await testRetryCountIsPropagatedToDispatchJob();
  await testSweepSkipsUnconfirmedDeliveryAsPermanent();
  await testSweepIsNoOpWhenAutoRetryDisabled();

  console.log("dispatch failure retry processor tests OK");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueueInfrastructure();
  });
