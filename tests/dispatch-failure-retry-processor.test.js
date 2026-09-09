const assert = require("node:assert/strict");

const { closeQueueInfrastructure } = require("../src/queues/bullmq");
const {
  MAX_RETRIES_PER_SWEEP,
  MAX_RETRY_ATTEMPTS,
  createDispatchFailureRetryProcessor,
  isPermanentFailureMessage,
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

/*
  Regressao: o reenvio precisa ser o MESMO envio.

  buildRetryJobData remontava o job a partir do log e perdia sete campos, cada
  um mudando o que chegava no grupo:

    - sem whatsapp_instance_id, resolveInstance(undefined) escolhia a primeira
      instancia disponivel: o reenvio podia sair por outro numero (que talvez
      nem participe do grupo - a Evolution responde 200 e o Baileys descarta em
      silencio), e updateStatus gravava null, apagando do relatorio o numero que
      ja estava registrado;
    - sem legenda/caption_id/caption_generated, resolveDispatchCaption chamava a
      IA de novo e o grupo recebia um texto que ninguem aprovou.
*/
async function testRetryPreservaInstanciaELegendaAprovada() {
  const logs = [
    buildFailedLog(1, {
      campaign_id: "campaign-1",
      group_id: "group-1",
      video_id: "video-1",
      whatsapp_instance_id: "instance-do-envio-original",
    }),
  ];
  const { enqueued, options } = createDeps(logs, {
    campaignVideoCaptionsRepository: {
      listByCampaign: async (campaignId) => {
        assert.equal(campaignId, "campaign-1");
        return [
          { id: "caption-aprovada", group_id: "group-1", video_id: "video-1", status: "gerado", caption_text: "texto revisado na Etapa 2" },
          // Ruido: outro par, e uma legenda nao aprovada, que nao devem casar.
          { id: "caption-outra", group_id: "group-9", video_id: "video-9", status: "gerado", caption_text: "nao e desta" },
          { id: "caption-rascunho", group_id: "group-1", video_id: "video-1", status: "rascunho", caption_text: "nao aprovada" },
        ];
      },
    },
    settingsService: {
      getDispatchRulesSettings: async () => ({
        auto_retry_failures: true,
        never_repeat_video: true,
        auto_generate_caption: false,
      }),
    },
  });

  await createDispatchFailureRetryProcessor(options)();

  assert.equal(enqueued.length, 1);
  const job = enqueued[0];

  assert.equal(
    job.whatsapp_instance_id,
    "instance-do-envio-original",
    "o reenvio precisa sair pelo mesmo numero do envio original"
  );
  assert.equal(
    job.legenda,
    "texto revisado na Etapa 2",
    "o reenvio precisa repetir a legenda aprovada, nao gerar outra"
  );
  assert.equal(job.caption_id, "caption-aprovada");
  assert.equal(job.caption_generated, true, "caption_generated=true e o que impede uma segunda chamada de IA");
  assert.equal(job.never_repeat_video, true, "as regras do disparo nao podem voltar ao default no reenvio");
  assert.equal(job.auto_generate_caption, false);
}

// Sem legenda aprovada para o par, o reenvio ainda acontece (a IA escolhe uma) -
// perder a legenda nao pode virar envio bloqueado.
async function testRetrySegueSemLegendaAprovada() {
  const logs = [buildFailedLog(1, { whatsapp_instance_id: "instance-1" })];
  const { enqueued, options } = createDeps(logs, {
    campaignVideoCaptionsRepository: {
      listByCampaign: async () => {
        throw new Error("captions indisponivel");
      },
    },
  });

  const result = await createDispatchFailureRetryProcessor(options)();

  assert.equal(result.retried, 1, "falha ao ler legendas nao pode barrar o reprocessamento");
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].legenda, "");
  assert.equal(enqueued[0].caption_id, undefined);
  assert.equal(enqueued[0].whatsapp_instance_id, "instance-1", "a instancia continua preservada");
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

/*
  Classificacao de falha por mensagem, com o timeout no centro.

  O timeout da Evolution nao era tratado como permanente, entao o sweep o
  reenfileirava - apesar de a propria mensagem montada por parseEvolutionError
  dizer "a midia pode ter sido entregue mesmo assim". Video grande e' exatamente
  o que estoura os 180s de mediaTimeoutMs E o que a Evolution mais provavelmente
  ja entregou, entao o reenvio postava o mesmo video de novo no grupo.

  "Indisponivel ou sem resposta" continua transitorio de proposito: ali a
  requisicao nao foi aceita e reenviar e' o comportamento certo.
*/
function testClassificacaoDeFalhaPorMensagem() {
  const permanentes = [
    "Tempo limite excedido aguardando resposta da Evolution API (a midia pode ter sido entregue mesmo assim)",
    "Envio aceito pela Evolution, mas o WhatsApp nao confirmou a entrega em 15s",
    "Falha na chamada para Evolution API (HTTP 413: request entity too large)",
    "Payload de midia com 200000000 bytes excede o limite de 142606336 bytes",
  ];
  const transitorias = [
    "Evolution API indisponivel ou sem resposta",
    "Falha na chamada para Evolution API (HTTP 500: Internal Server Error)",
    "fetch failed",
  ];

  for (const message of permanentes) {
    assert.equal(
      isPermanentFailureMessage(message),
      true,
      `deveria ser permanente (reenviar arrisca duplicar ou nao muda nada): ${message}`
    );
  }

  for (const message of transitorias) {
    assert.equal(
      isPermanentFailureMessage(message),
      false,
      `deveria ser transitoria (a mensagem nao saiu; reenviar e' correto): ${message}`
    );
  }
}

async function main() {
  testClassificacaoDeFalhaPorMensagem();
  await testSweepPassesFilterAndLimitToRepository();
  await testSweepCapsRetriesPerRun();
  await testSweepSkipsExhaustedLogsEvenIfRepositoryReturnsThem();
  await testRetryCountIsPropagatedToDispatchJob();
  await testSweepSkipsUnconfirmedDeliveryAsPermanent();
  await testRetryPreservaInstanciaELegendaAprovada();
  await testRetrySegueSemLegendaAprovada();
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
