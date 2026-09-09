const assert = require("node:assert/strict");

const {
  createCampaignTriggerProcessor,
  isDeterministicCampaignFailure,
} = require("../src/queues/campaign-trigger");
const { closeQueueInfrastructure } = require("../src/queues/bullmq");

/*
  O QUE ACONTECIA.

  O catch do campaignTriggerWorker tratava TODA excecao como "campanha invalida"
  e gravava `ativo: false`, com `.catch(() => undefined)` descartando ate a
  falha de desativar. Um erro transitorio do Supabase ao criar o 37o log
  pendente tinha exatamente o mesmo desfecho que uma campanha malformada.

  E o desfecho era terminal: esta fila roda com attempts: 1, e claimTriggerFired
  (atomico, irreversivel) ja tinha sido reivindicado ANTES da criacao dos jobs -
  entao um retry encontrava o claim perdido e virava no-op. A campanha nunca mais
  disparava, nem manualmente. Da tela, indistinguivel de "o sistema cancelou
  sozinho". Nenhuma notificacao era emitida nesse caminho.

  A REGRA AGORA.

    deterministico                -> desativa (repetir daria o mesmo erro)
    transitorio, sem job criado   -> libera o claim, NAO desativa
    transitorio, com jobs criados -> nao desativa e nao libera (os jobs estao a
                                     caminho dos grupos; liberar duplicaria)

  Em todos os casos, notifica: uma campanha que nao disparou e' o que o operador
  precisa saber na hora.
*/

const CAMPAIGN_UUID = "11111111-1111-4111-8111-111111111111";
const GROUP_UUID = "22222222-2222-4222-8222-222222222222";
const VIDEO_UUID = "33333333-3333-4333-8333-333333333333";

const silentLogger = { info() {}, warn() {}, error() {} };

function createFakeJob(data) {
  return {
    id: "trigger-job-1",
    data,
    async updateData(next) {
      this.data = next;
    },
  };
}

function buildTriggerHarness(options = {}) {
  const updates = [];
  const released = [];
  const notified = [];
  const enqueued = [];

  const processor = createCampaignTriggerProcessor({
    campaigns: {
      findById: async (id) => ({ id, status: "programado", trilha: "Trilha X", ativo: true }),
      claimTriggerFired: async (id) => ({ id, trigger_fired_at: new Date().toISOString() }),
      update: async (id, payload) => {
        updates.push({ id, payload });
        return { id, ...payload };
      },
      releaseTriggerClaim: async (id) => {
        released.push(id);
        return { id, trigger_fired_at: null };
      },
    },
    campaignGroups: {
      listGroups: async () => [
        {
          group_id: GROUP_UUID,
          groups: {
            id: GROUP_UUID,
            nome: "Grupo",
            envia_video: true,
            evolution_group_id: "120363@g.us",
            trilha_id: "trilha-1",
          },
        },
      ],
    },
    dispatchLogs: {
      // O ponto de falha injetavel: e' aqui que a criacao de log quebrava.
      createLog: options.createLog || (async (payload) => ({ id: "log-1", ...payload })),
      findByTrio: async () => null,
      updateDispatchJobId: async () => ({}),
      updatePlannedSchedule: async () => ({}),
      updateInstance: async () => ({}),
    },
    videoFlowRepository: {
      beginResolution() {},
      findNextApprovedUnsentVideoForGroup: async () => ({
        id: VIDEO_UUID,
        status: true,
        drive_file_id: "drive-1",
        ordem: 1,
      }),
    },
    addDispatchJob: options.addDispatchJob || (async (data) => {
      enqueued.push(data);
      return { id: `dispatch-${enqueued.length}`, data };
    }),
    addJitteredDispatchJobs: async (params) => {
      const jobs = (params.groups || []).map((group, index) => {
        const data = { ...group, campaign_id: params.campaign_id, scheduled_at: new Date().toISOString() };
        enqueued.push(data);
        return { id: `dispatch-${index + 1}`, data };
      });
      return jobs;
    },
    whatsappInstancesRepository: {
      listDispatchable: async () => [{ id: "instance-1", instance_name: "Numero A", priority: 0 }],
      listActive: async () => [{ id: "instance-1", instance_name: "Numero A", priority: 0 }],
    },
    whatsappInstancesService: {
      getRotationSettings: async () => ({ whatsapp_rotation_group_count: 1 }),
      filterDispatchableGroups: async (ids) => ({ eligible: ids, ineligible: [] }),
    },
    settingsService: { getDispatchRulesSettings: async () => ({}) },
    notificationsService: {
      notifyCampaignStarted: async () => ({ sent: true }),
      notifyDispatchFailure: async (payload) => {
        notified.push(payload);
        return { sent: true };
      },
    },
    inAppNotificationsService: { notifyTrailFinished: async () => ({ sent: true }) },
    trilhasRepository: { listVideoLinksByTrilha: async () => [{ video_id: VIDEO_UUID, ordem: 1 }] },
    videoCatalogRepository: { listApproved: async () => [{ id: VIDEO_UUID, status: true, drive_file_id: "drive-1" }] },
    groupVideoProgressRepository: { listDelivered: async () => [] },
    logger: silentLogger,
  });

  return { processor, updates, released, notified, enqueued };
}

function buildJobData() {
  return createFakeJob({
    campaign_id: CAMPAIGN_UUID,
    execution_at: new Date().toISOString(),
    trigger_type: "once",
  });
}

// (1) Falha TRANSITORIA depois de os jobs terem sido criados: nao desativa a
//     campanha e nao libera o claim. Os jobs sao envios legitimos a caminho.
async function testFalhaTransitoriaComJobsNaoDesativaCampanha() {
  const harness = buildTriggerHarness({
    createLog: async () => {
      const error = new Error("fetch failed");
      error.code = "UND_ERR_SOCKET";
      throw error;
    },
  });

  await assert.rejects(() => harness.processor(buildJobData()), /fetch failed/);

  assert.equal(harness.enqueued.length > 0, true, "os jobs foram criados antes da falha");
  assert.deepEqual(
    harness.updates.filter((entry) => entry.payload.ativo === false),
    [],
    "erro transitorio NAO pode desativar a campanha - era o bug"
  );
  assert.deepEqual(harness.released, [], "com jobs em voo, liberar o claim duplicaria o envio");
  assert.equal(harness.notified.length, 1, "a falha precisa chegar ao operador");
  assert.match(harness.notified[0].errorMessage, /jobs_em_voo_estado_parcial|ja enfileirado/);
}

// (2) Falha TRANSITORIA antes de qualquer job: libera o claim para a campanha
//     poder disparar de novo. Sem isso ela ficava reivindicada para sempre.
async function testFalhaTransitoriaSemJobsLiberaOClaim() {
  const harness = buildTriggerHarness({
    addDispatchJob: async () => {
      const error = new Error("Connection terminated unexpectedly");
      throw error;
    },
  });

  await assert.rejects(() => harness.processor(buildJobData()), /Connection terminated/);

  assert.deepEqual(
    harness.updates.filter((entry) => entry.payload.ativo === false),
    [],
    "erro transitorio NAO desativa"
  );
  assert.deepEqual(harness.released, [CAMPAIGN_UUID], "sem job criado, o claim precisa voltar para nulo");
  assert.equal(harness.notified.length, 1);
}

// (3) Falha DETERMINISTICA: desativa, como antes. Repetir daria o mesmo erro, e
//     deixar a campanha ativa faria o trigger bater na mesma parede.
async function testFalhaDeterministicaDesativaCampanha() {
  const harness = buildTriggerHarness({
    addDispatchJob: async () => {
      const error = new Error('new row for relation "logs" violates check constraint "logs_status_check"');
      error.code = "23514";
      throw error;
    },
  });

  await assert.rejects(() => harness.processor(buildJobData()), /violates check constraint/);

  assert.deepEqual(
    harness.updates.filter((entry) => entry.payload.ativo === false).map((entry) => entry.id),
    [CAMPAIGN_UUID],
    "falha deterministica continua desativando a campanha"
  );
  assert.deepEqual(harness.released, [], "nao faz sentido liberar o claim de uma campanha invalida");
}

// (4) O classificador em si. Errar para o lado de "transitorio" deixa a campanha
//     viva para o operador reprocessar; errar para "deterministico" a mata em
//     silencio - que e' o bug que este classificador existe para nao repetir.
function testClassificadorDeFalha() {
  const deterministicas = [
    new Error("Campaign not found"),
    new Error("Group not found"),
    new Error("janela da campanha nao comporta todos os grupos com o jitter minimo configurado"),
    Object.assign(new Error("qualquer"), { code: "DISPATCH_WINDOW_TOO_SHORT" }),
    Object.assign(new Error("qualquer"), { code: "23514" }),
    new Error('new row violates not-null constraint'),
  ];
  const transitorias = [
    new Error("fetch failed"),
    Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }),
    new Error("Connection terminated unexpectedly"),
    new Error("TypeError: Cannot read properties of undefined"),
    Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
  ];

  for (const error of deterministicas) {
    assert.equal(isDeterministicCampaignFailure(error), true, `deveria ser deterministica: ${error.message}`);
  }

  for (const error of transitorias) {
    assert.equal(isDeterministicCampaignFailure(error), false, `deveria ser transitoria: ${error.message}`);
  }

  assert.equal(isDeterministicCampaignFailure(null), false);
  assert.equal(isDeterministicCampaignFailure(undefined), false);
}

async function main() {
  testClassificadorDeFalha();
  await testFalhaTransitoriaComJobsNaoDesativaCampanha();
  await testFalhaTransitoriaSemJobsLiberaOClaim();
  await testFalhaDeterministicaDesativaCampanha();

  console.log("campaign-trigger failure recovery tests OK");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueueInfrastructure();
  });
