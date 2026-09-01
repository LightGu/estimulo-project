/*
  Compressao do anexo do Disparador Pontual.

  O anexo sobe em base64 e segue para a Evolution no corpo JSON. Sem preparo, um
  video grande era recusado no upload (413) e, quando passava, ia inteiro para
  dentro de cada job da fila - um job por grupo, ou seja, o mesmo base64
  duplicado N vezes no Redis.

  Estes testes fixam o contrato do preparo, sem rodar ffmpeg (o preparador e
  injetado):

    - o preparo roda UMA vez por disparo, nao uma vez por grupo;
    - o que vai para a fila e para a Evolution e o content JA preparado;
    - disparo so de texto nao invoca o preparo.
*/
const assert = require("node:assert/strict");

const { createMensagensService } = require("../src/services/mensagens.service");

const PREPARED_BASE64 = Buffer.alloc(64, 9).toString("base64");

function buildHarness(overrides = {}) {
  const { gatePreparation, ...serviceOverrides } = overrides;
  const enqueued = [];
  const sentParams = [];
  const prepareCalls = [];
  const statusUpdates = [];
  const plannedScheduleUpdates = [];
  let logs = [];

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
        return { id: "campaign-1", ...payload };
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
        const log = { id: `log-${logs.length + 1}`, ...payload };
        logs.push(log);
        return log;
      },
      async listByCampaign() {
        return logs;
      },
      async updateProviderDelivery() {
        return {};
      },
      async updateStatus(id, status, mensagemErro) {
        statusUpdates.push({ id, status, mensagemErro });
        return {};
      },
      async updatePlannedSchedule(id, horario) {
        plannedScheduleUpdates.push({ id, horario });
        return {};
      },
      async updateDispatchJobId(id, jobId) {
        return { id, jobId };
      },
    },
    whatsappInstancesRepository: {
      async listActive() {
        return [{ id: "instance-1", instance_name: "numero-1" }];
      },
      async listDispatchable() {
        return [{ id: "instance-1", instance_name: "numero-1" }];
      },
      async findById() {
        return { id: "instance-1", instance_name: "numero-1" };
      },
    },
    whatsappInstancesService: {
      async listDispatchableInstances() {
        return [{ id: "instance-1", instance_name: "numero-1" }];
      },
      async getRotationSettings() {
        return {};
      },
    },
    settingsService: {
      async getSettings() {
        return { timezone: "America/Sao_Paulo" };
      },
    },
    sendToEvolution: async (params) => {
      sentParams.push(params);
      return { ok: true };
    },
    addMensagensDispatchJob: async (params, options) => {
      enqueued.push({ params, options });
      return { id: `job-${enqueued.length}` };
    },
    prepareAdHocMediaContent: async (content) => {
      prepareCalls.push(content);

      if (gatePreparation) {
        await gatePreparation();
      }

      if (!content || content.type !== "video") {
        return content;
      }

      return { ...content, base64: PREPARED_BASE64, mimeType: "video/mp4", fileName: "video.mp4" };
    },
    logger: { info() {}, warn() {}, error() {} },
    ...serviceOverrides,
  });

  return { service, enqueued, sentParams, prepareCalls, statusUpdates, plannedScheduleUpdates };
}

function buildVideoPayload(groupIds) {
  return {
    group_ids: groupIds,
    texto: "mensagem",
    content: {
      base64: Buffer.alloc(4096, 1).toString("base64"),
      mimeType: "video/quicktime",
      fileName: "original.mov",
      type: "video",
    },
  };
}

// Espera as continuacoes em segundo plano (preparo + enfileiramento) drenarem.
async function flushBackground() {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// O preparo tem que acontecer fora do loop de grupos: dentro dele, o mesmo
// video passaria pelo ffmpeg uma vez por grupo do disparo.
async function testPreparoRodaUmaVezParaVariosGrupos() {
  const harness = buildHarness();

  await harness.service.dispatchAdHoc(buildVideoPayload(["g1", "g2", "g3"]));

  assert.equal(harness.prepareCalls.length, 1, "o preparo deve rodar uma unica vez, nao por grupo");
  assert.equal(harness.sentParams.length, 3, "os tres grupos devem receber o envio");

  for (const params of harness.sentParams) {
    assert.equal(params.content.base64, PREPARED_BASE64, "a Evolution deve receber o video preparado");
    assert.equal(params.content.mimeType, "video/mp4");
  }
}

/*
  O ponto do envio assincrono: a resposta nao pode esperar o ffmpeg.

  Com o preparo travado, dispatchAdHocAsync tem que responder assim mesmo - e e
  esse retorno imediato que evita o timeout de proxy / "Failed to fetch" que um
  video grande provocava.
*/
async function testRespostaNaoEsperaPreparoDaMidia() {
  let liberarPreparo;
  const preparoTravado = new Promise((resolve) => {
    liberarPreparo = resolve;
  });
  const harness = buildHarness({ gatePreparation: () => preparoTravado });

  const resultado = await harness.service.dispatchAdHocAsync(buildVideoPayload(["g1"]));

  assert.equal(resultado.preparando_midia, true, "a resposta deve sinalizar que a midia ainda esta sendo preparada");
  assert.ok(resultado.campaign_id, "o campaign_id tem que vir na resposta para a tela poder fazer polling");
  assert.equal(harness.enqueued.length, 0, "nada pode ser enfileirado antes do preparo terminar");

  liberarPreparo();
  await flushBackground();

  assert.equal(harness.enqueued.length, 1, "o job entra na fila depois que o preparo conclui");
  assert.equal(harness.enqueued[0].params.content.base64, PREPARED_BASE64);
}

// Prova que o base64 cru nao entra no Redis: o job carrega o content preparado.
async function testAgendamentoEnfileiraContentPreparado() {
  const harness = buildHarness();
  const windowStart = new Date(Date.now() + 60 * 60 * 1000);
  const windowEnd = new Date(windowStart.getTime() + 60 * 60 * 1000);

  const resultado = await harness.service.scheduleAdHoc({
    ...buildVideoPayload(["g1", "g2"]),
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
    jitter_delay_min_ms: 1000,
    jitter_delay_max_ms: 2000,
  });

  assert.equal(resultado.preparando_midia, true, "o agendamento com video tambem nao espera o ffmpeg");
  await flushBackground();

  assert.equal(harness.prepareCalls.length, 1, "o preparo deve rodar uma vez antes de enfileirar");
  assert.ok(harness.enqueued.length >= 2, "cada grupo deve gerar um job");

  for (const job of harness.enqueued) {
    assert.equal(job.params.content.base64, PREPARED_BASE64, "o job nao pode carregar o base64 original");
  }
}

// Os horarios do agendamento sao escolha do usuario: o preparo em segundo plano
// nao pode reescreve-los (ao contrario do disparo imediato).
async function testAgendamentoPreservaHorariosDaJanela() {
  const harness = buildHarness();
  const windowStart = new Date(Date.now() + 60 * 60 * 1000);
  const windowEnd = new Date(windowStart.getTime() + 60 * 60 * 1000);

  const resultado = await harness.service.scheduleAdHoc({
    ...buildVideoPayload(["g1", "g2"]),
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
    jitter_delay_min_ms: 1000,
    jitter_delay_max_ms: 2000,
  });

  await flushBackground();

  const planejados = resultado.jobs.map((job) => String(job.scheduled_at));
  const enfileirados = harness.enqueued.map((job) => String(job.params.scheduled_at));

  assert.deepEqual(enfileirados, planejados, "os horarios enfileirados devem ser os da janela agendada");
}

async function testEnvioAssincronoEnfileiraContentPreparado() {
  const harness = buildHarness();

  await harness.service.dispatchAdHocAsync(buildVideoPayload(["g1"]));
  await flushBackground();

  assert.equal(harness.prepareCalls.length, 1);
  assert.equal(harness.enqueued.length, 1);
  assert.equal(harness.enqueued[0].params.content.base64, PREPARED_BASE64);
}

/*
  O disparo imediato re-estampa o horario planejado depois do preparo. Sem isso,
  uma compressao longa faria o job nascer com scheduled_at antigo e a trava de
  atraso do worker (resolveJobStaleReason) o cancelaria sem enviar.
*/
async function testDisparoImediatoReestampaHorarioAposPreparo() {
  let liberarPreparo;
  const preparoTravado = new Promise((resolve) => {
    liberarPreparo = resolve;
  });
  const harness = buildHarness({ gatePreparation: () => preparoTravado });

  await harness.service.dispatchAdHocAsync(buildVideoPayload(["g1"]));

  const antesDoPreparo = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 25));
  liberarPreparo();
  await flushBackground();

  assert.equal(harness.enqueued.length, 1);
  const enfileiradoEm = new Date(harness.enqueued[0].params.scheduled_at).getTime();

  assert.ok(
    enfileiradoEm >= antesDoPreparo,
    "o horario do job deve ser o do fim do preparo, nao o do inicio da requisicao"
  );
  assert.ok(harness.plannedScheduleUpdates.length >= 1, "o log pendente deve ter o horario planejado atualizado");
}

// Compressao quebrada nao pode deixar o log em "pendente" para sempre: sem isso
// getDispatchStatus nunca finaliza e a tela fica girando.
async function testFalhaNoPreparoMarcaLogsComoFalhou() {
  const harness = buildHarness({
    gatePreparation: () => {
      throw new Error("ffmpeg quebrou");
    },
  });

  await harness.service.dispatchAdHocAsync(buildVideoPayload(["g1"]));
  await flushBackground();

  assert.equal(harness.enqueued.length, 0, "nada deve ser enviado se a midia nao ficou pronta");
  assert.equal(harness.statusUpdates.length, 1, "o log pendente deve ser fechado como falha");
  assert.equal(harness.statusUpdates[0].status, "falhou");
  assert.match(harness.statusUpdates[0].mensagemErro, /ffmpeg quebrou/);
}

async function testTextoPuroNaoInvocaCompressao() {
  const harness = buildHarness();

  await harness.service.dispatchAdHoc({ group_ids: ["g1"], texto: "so texto" });

  assert.equal(harness.prepareCalls.length, 1, "o preparo e chamado, mas recebe content vazio");
  assert.equal(harness.prepareCalls[0], undefined, "sem midia nao ha content para preparar");
  assert.equal(harness.sentParams[0].content, undefined, "envio de texto nao deve carregar content");
}

async function main() {
  await testPreparoRodaUmaVezParaVariosGrupos();
  await testRespostaNaoEsperaPreparoDaMidia();
  await testAgendamentoEnfileiraContentPreparado();
  await testAgendamentoPreservaHorariosDaJanela();
  await testEnvioAssincronoEnfileiraContentPreparado();
  await testDisparoImediatoReestampaHorarioAposPreparo();
  await testFalhaNoPreparoMarcaLogsComoFalhou();
  await testTextoPuroNaoInvocaCompressao();

  console.log("mensagens-adhoc-media-compression tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
