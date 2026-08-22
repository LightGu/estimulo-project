// Trava de regressao do incidente de SPAM ao subir a infra do Docker.
//
// O QUE ACONTECEU: o Redis da infra sobe com `--appendonly yes` e volume
// persistente, entao todo job de envio que nao terminou continua gravado entre
// um `docker compose down` e o proximo `up`. Quando os workers voltam, a BullMQ
// promove de uma vez todos os jobs `delayed` com horario vencido e reentrega os
// que ficaram `active` no shutdown. Como nenhuma trava efetiva existia na
// entrada do worker de video, cada boot reenviava para os grupos de WhatsApp
// videos e mensagens agendados dias antes.
//
// Estes testes cobrem o cenario pelo lado que importa para o cliente: o sender
// NUNCA pode ser chamado. Por isso quase todo assert aqui e negativo
// (`sent.length === 0`), incluindo o download do Drive - no caminho sem
// dispatch-consistency o download acontecia antes de qualquer decisao.

const assert = require("node:assert/strict");

const { closeQueueInfrastructure } = require("../src/queues/bullmq");
const { buildDispatchJobData, createDispatchProcessor } = require("../src/queues/dispatch");
const { createCampaignTriggerProcessor, resolveTriggerStaleReason } = require("../src/queues/campaign-trigger");
const { createMensagensDispatchProcessor } = require("../src/queues/mensagens-dispatch");
const { createDispatchConsistencyService } = require("../src/services/dispatch-consistency.service");
const { buildRetryJobData, createDispatchFailureRetryProcessor } = require("../src/queues/dispatch-failure-retry");
const { createDispatchReviewTimeoutProcessor } = require("../src/queues/dispatch-review-timeout");

const silentLogger = { info() {}, warn() {}, error() {} };

// UUIDs validos: canUseDispatchConsistency (src/queues/dispatch.js) so liga a
// camada de consistencia quando campanha/grupo/video sao UUID.
const CAMPAIGN_UUID = "11111111-1111-1111-8111-111111111111";
const GROUP_UUID = "22222222-2222-1222-8222-222222222222";
const VIDEO_UUID = "33333333-3333-1333-8333-333333333333";

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function minutesAgoIso(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function createFakeJob(data, id = "job-1") {
  const updates = [];

  return {
    id,
    data,
    updates,
    async updateData(nextData) {
      updates.push(nextData);
      this.data = nextData;
    },
  };
}

// Monta o processor de video espionando TODOS os efeitos externos que importam:
// envio ao provedor, download do video e criacao/cancelamento de log.
function buildDispatchHarness(options = {}) {
  const sent = [];
  const downloads = [];
  const createdLogs = [];
  const cancelledLogs = [];
  const existingLogs = options.existingLogs || [];

  const dispatchLogs = {
    listByCampaign: async () => existingLogs,
    createLog: async (payload) => {
      const record = { id: `log-${createdLogs.length + 1}`, ...payload };
      createdLogs.push(record);
      existingLogs.push(record);
      return record;
    },
    cancelIfPending: async (id, mensagemErro) => {
      cancelledLogs.push({ id, mensagemErro });
      return { id, status: "cancelado" };
    },
    claimForSend: async (id) => ({ id, status: "processando" }),
    updateStatus: async () => ({}),
    updateProviderDelivery: async () => ({}),
  };

  const processor = createDispatchProcessor({
    sender: async (payload) => {
      sent.push(payload);
      return { status: 200, data: { key: { id: "msg-1" }, success: true } };
    },
    videoDownloader: async (params) => {
      downloads.push(params);
      return { bytes: Buffer.from("video"), name: "v.mp4", mime_type: "video/mp4" };
    },
    confirmDelivery: async () => ({ confirmed: true }),
    dispatchLogs,
    dispatchConsistencyService: options.dispatchConsistencyService,
    campaignsRepository: {
      findById: async (id) => ({ id, status: options.campaignStatus || "programado", trilha: "Trilha X" }),
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

  return { processor, sent, downloads, createdLogs, cancelledLogs };
}

function buildVideoJobData(overrides = {}) {
  return buildDispatchJobData({
    group_id: "120363000000000000@g.us",
    campaign_id: CAMPAIGN_UUID,
    progress_group_id: GROUP_UUID,
    video_id: VIDEO_UUID,
    drive_file_id: "drive-1",
    legenda: "Legenda ja aprovada",
    caption_generated: true,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// P0 - o bug de producao
// ---------------------------------------------------------------------------

// Antes da correcao o worker de video nao olhava job.data.scheduled_at em
// momento nenhum: a unica trava vivia dentro de dispatch-consistency, comparada
// contra log.horario_envio_planejado - que e nulo em todo log criado por
// createAttemptLog. Um job de dias atras promovido no boot ia direto ao envio.
async function testJobDeDiasAtrasNaoChamaOSender() {
  const harness = buildDispatchHarness();
  const job = createFakeJob(buildVideoJobData({ scheduled_at: daysAgoIso(4) }));

  const result = await harness.processor(job);

  assert.equal(harness.sent.length, 0, "job de dias atras nao pode chamar o sender");
  assert.equal(harness.downloads.length, 0, "nao pode nem baixar o video do Drive");
  assert.equal(harness.createdLogs.length, 0, "nao pode criar log de tentativa novo");
  assert.equal(result.status, "cancelado");
  assert.equal(job.data.status, "cancelado");
  assert.match(job.data.cancel_reason, /atraso/);
}

// O caminho mais perigoso: ids que nao sao UUID desligam canUseDispatchConsistency,
// e com ele a checagem de campanha, o claim do log e a trava de atraso interna.
// Este ramo enviava sem nenhuma verificacao.
async function testJobVencidoSemConsistenciaTambemNaoEnvia() {
  const harness = buildDispatchHarness();
  const job = createFakeJob(
    buildDispatchJobData({
      group_id: "120363000000000000@g.us",
      campaign_id: "campaign-legado",
      progress_group_id: "group-legado",
      video_id: "video-legado",
      link_video: "https://example.com/v.mp4",
      scheduled_at: daysAgoIso(9),
    })
  );

  const result = await harness.processor(job);

  assert.equal(harness.sent.length, 0, "ramo sem consistencia tambem precisa da trava de atraso");
  assert.equal(harness.downloads.length, 0);
  assert.equal(result.status, "cancelado");
}

// Falha fechado: job sem scheduled_at nao da para validar, entao nao envia.
// Nenhum caminho legitimo cria job assim (buildDispatchJobData sempre preenche);
// um job nesse estado e legado/corrompido.
async function testJobSemHorarioNaoEnvia() {
  const harness = buildDispatchHarness();
  const job = createFakeJob({ ...buildVideoJobData(), scheduled_at: undefined });

  const result = await harness.processor(job);

  assert.equal(harness.sent.length, 0, "sem horario planejado a resposta segura e nao enviar");
  assert.equal(result.status, "cancelado");
  assert.match(result.reason, /sem horario planejado/);
}

// Reproduz a forma do incidente: o boot drena a fila inteira de uma vez.
// Nenhum dos jobs vencidos pode escapar.
async function testBootStormNaoEnviaNenhumaMensagem() {
  const harness = buildDispatchHarness();
  const jobs = Array.from({ length: 12 }, (_, index) =>
    createFakeJob(
      buildVideoJobData({
        group_id: `12036300000000${index}@g.us`,
        scheduled_at: daysAgoIso(2),
      }),
      `job-${index}`
    )
  );

  await Promise.all(jobs.map((job) => harness.processor(job).catch((error) => error)));

  assert.equal(harness.sent.length, 0, `nenhum dos ${jobs.length} jobs vencidos pode enviar`);
  assert.equal(harness.downloads.length, 0);
}

// Guarda-chuva contra regressao: envio dentro do prazo continua funcionando.
// Sem este teste, "nao enviar nunca" passaria a suite inteira.
async function testJobRecenteAindaEnviaNormalmente() {
  const harness = buildDispatchHarness();
  const job = createFakeJob(buildVideoJobData({ scheduled_at: minutesAgoIso(2) }));

  const result = await harness.processor(job);

  assert.equal(harness.sent.length, 1, "envio dentro do prazo nao pode ser bloqueado");
  assert.equal(result.status, "sent");
}

// ---------------------------------------------------------------------------
// P0 - campaign-trigger: a rajada para todos os grupos
// ---------------------------------------------------------------------------

// Este e o mecanismo que gerou o print do incidente: um job de trigger parado no
// Redis dispara no boot, monta os horarios a partir da janela original (toda no
// passado) e buildDispatchJobOptions calcula delay 0 para TODOS os grupos.
async function testTriggerVencidoNaoEnfileiraNadaNemNotifica() {
  const dispatchJobs = [];
  const createdLogs = [];
  let notifyCalled = false;

  const processor = createCampaignTriggerProcessor({
    validateCampaignId: false,
    campaigns: {
      findById: async (id) => ({ id, status: "programado", trilha: "Trilha X" }),
      claimTriggerFired: async (id) => ({ id }),
      update: async () => ({}),
    },
    campaignGroups: {
      listGroups: async () =>
        Array.from({ length: 8 }, (_, index) => ({
          groups: {
            id: `group-${index}`,
            evolution_group_id: `12036300000000${index}@g.us`,
            segmento: "Pre infancia",
            trilha_id: "trilha-1",
            envia_video: true,
          },
        })),
    },
    campaignVideoCaptionsRepository: { listByCampaign: async () => [] },
    dispatchLogs: {
      listByCampaign: async () => [],
      createLog: async (payload) => {
        const record = { id: `log-${createdLogs.length + 1}`, ...payload };
        createdLogs.push(record);
        return record;
      },
    },
    videoFlowRepository: {
      findNextApprovedUnsentVideoForGroup: async () => ({ id: "video-1", drive_file_id: "drive-1" }),
    },
    whatsappInstancesService: {
      filterDispatchableGroups: async (ids) => ({ eligible: ids, ineligible: [] }),
      getRotationSettings: async () => ({ whatsapp_rotation_group_count: 1 }),
    },
    whatsappInstancesRepository: { listActive: async () => [] },
    addDispatchJob: async (payload) => {
      dispatchJobs.push(payload);
      return { id: `dispatch-${dispatchJobs.length}`, data: payload };
    },
    addJitteredDispatchJobs: async (payload) => {
      dispatchJobs.push(payload);
      return [];
    },
    notificationsService: {
      notifyCampaignStarted: async () => {
        notifyCalled = true;
        return { sent: true };
      },
    },
    settingsService: { getDispatchRulesSettings: async () => ({}) },
    logger: silentLogger,
  });

  const job = createFakeJob({
    campaign_id: CAMPAIGN_UUID,
    execution_at: daysAgoIso(5),
    time_window: { start: daysAgoIso(5), end: daysAgoIso(5) },
    dispatch_jitter: { min_ms: 1000, max_ms: 2000 },
  });

  const result = await processor(job);

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "trigger_stale");
  assert.equal(dispatchJobs.length, 0, "trigger vencido nao pode criar job de disparo para nenhum grupo");
  assert.equal(createdLogs.length, 0, "nao pode criar logs pendentes para a campanha antiga");
  assert.equal(notifyCalled, false, "nao pode anunciar 'campanha iniciada' no WhatsApp");
}

// Campanha recorrente (cron) precisa continuar funcionando: nela o disparo do
// cron E o horario legitimo, e a janela gravada no job e a do cadastro.
async function testTriggerRecorrenteNaoEBloqueadoPelaJanelaAntiga() {
  const reason = resolveTriggerStaleReason({
    trigger_type: "recurring",
    time_window: { start: daysAgoIso(30), end: daysAgoIso(30) },
  });

  assert.equal(reason, null, "campanha recorrente nao pode ser barrada pela janela do cadastro");
}

// Janela com hora-solta ("10:00") nao e comparavel com "agora"; execution_at
// (sempre uma data completa) precisa governar a decisao.
async function testTriggerComJanelaHoraSoltaUsaExecutionAt() {
  const vencido = resolveTriggerStaleReason({
    execution_at: daysAgoIso(3),
    time_window: { start: "09:00", end: "10:00" },
  });
  const recente = resolveTriggerStaleReason({
    execution_at: minutesAgoIso(1),
    time_window: { start: "09:00", end: "10:00" },
  });

  assert.ok(vencido, "janela hora-solta nao pode desligar a trava de atraso");
  assert.equal(recente, null, "execucao recente continua valida");
}

// ---------------------------------------------------------------------------
// P1 - fail-open quando o log nao tem horario planejado
// ---------------------------------------------------------------------------

// createAttemptLog cria log sem horario_envio_planejado. Antes disso a trava
// interna comparava contra undefined e autorizava o envio - cego exatamente no
// primeiro envio de cada par campanha/grupo/video.
async function testConsistencyUsaHorarioDoJobQuandoLogNaoTem() {
  const sent = [];
  const cancelled = [];
  const service = createDispatchConsistencyService({
    dispatchLogsRepository: {
      listByCampaign: async () => [],
      createLog: async (payload) => ({ id: "log-1", ...payload, horario_envio_planejado: null }),
      claimForSend: async () => ({ id: "log-1" }),
      cancelIfPending: async (id, mensagemErro) => {
        cancelled.push({ id, mensagemErro });
        return { id, status: "cancelado" };
      },
      updateStatus: async () => ({}),
      updateProviderDelivery: async () => ({}),
    },
    campaignsRepository: { findById: async (id) => ({ id, status: "programado" }) },
    groupsRepository: { findById: async (id) => ({ id }), update: async () => ({}) },
    videoCatalogRepository: { findById: async (id) => ({ id }) },
    groupVideoProgressRepository: {
      hasDuplicate: async () => false,
      registerDelivery: async (payload) => ({ id: "progress-1", ...payload }),
    },
    settingsService: { getDispatchRulesSettings: async () => ({}) },
    logger: silentLogger,
  });

  const result = await service.executeDispatch({
    campaignId: CAMPAIGN_UUID,
    groupId: GROUP_UUID,
    videoId: VIDEO_UUID,
    scheduledAt: daysAgoIso(6),
    sender: async () => {
      sent.push(true);
      return { status: 200, data: { key: { id: "m" }, success: true } };
    },
  });

  assert.equal(sent.length, 0, "log sem horario planejado nao pode virar envio cego");
  assert.equal(result.skippedSend, true);
  assert.equal(result.status, "cancelado");
  assert.equal(cancelled.length, 1, "o log precisa ficar cancelado no relatorio");
}

// ---------------------------------------------------------------------------
// P2 - campanha cancelada/pausada com job sobrevivente no Redis
// ---------------------------------------------------------------------------

// Cancelar nao remove o job que ja esta no Redis: a checagem de status e a unica
// coisa entre o job sobrevivente e uma mensagem indevida no grupo.
async function testCampanhaCanceladaNaoEnviaMesmoComJobNaFila() {
  for (const status of ["cancelado", "pausado"]) {
    const sent = [];
    const created = [];
    const service = createDispatchConsistencyService({
      dispatchLogsRepository: {
        listByCampaign: async () => [],
        createLog: async (payload) => {
          created.push(payload);
          return { id: "log-1", ...payload };
        },
        claimForSend: async () => ({ id: "log-1" }),
        cancelIfPending: async () => ({ id: "log-1" }),
        updateStatus: async () => ({}),
        updateProviderDelivery: async () => ({}),
      },
      campaignsRepository: { findById: async (id) => ({ id, status }) },
      groupsRepository: { findById: async (id) => ({ id }), update: async () => ({}) },
      videoCatalogRepository: { findById: async (id) => ({ id }) },
      groupVideoProgressRepository: { hasDuplicate: async () => false, registerDelivery: async () => ({}) },
      settingsService: { getDispatchRulesSettings: async () => ({}) },
      logger: silentLogger,
    });

    const result = await service.executeDispatch({
      campaignId: CAMPAIGN_UUID,
      groupId: GROUP_UUID,
      videoId: VIDEO_UUID,
      scheduledAt: minutesAgoIso(1),
      sender: async () => {
        sent.push(true);
        return { status: 200, data: { key: { id: "m" }, success: true } };
      },
    });

    assert.equal(sent.length, 0, `campanha ${status} nao pode disparar job sobrevivente`);
    assert.equal(result.skippedSend, true);
    assert.equal(result.status, status);
    assert.equal(created.length, 0, "nao pode criar log novo por cima do cancelamento");
  }
}

// Mesma protecao no caminho sem dispatch-consistency (ids nao-UUID desligam a
// camada inteira), agora coberto pelo portao de entrada do worker.
async function testCampanhaCanceladaBloqueiaTambemSemConsistencia() {
  const harness = buildDispatchHarness({ campaignStatus: "cancelado" });
  const job = createFakeJob(
    buildDispatchJobData({
      group_id: "120363000000000000@g.us",
      campaign_id: CAMPAIGN_UUID,
      progress_group_id: "group-legado",
      video_id: "video-legado",
      link_video: "https://example.com/v.mp4",
      scheduled_at: minutesAgoIso(1),
    })
  );

  const result = await harness.processor(job);

  assert.equal(harness.sent.length, 0, "campanha cancelada bloqueia tambem o ramo sem consistencia");
  assert.equal(result.status, "cancelado");
}

// Mensagem pontual de campanha cancelada tambem nao pode sair.
async function testMensagemPontualDeCampanhaCanceladaNaoSai() {
  const sent = [];
  const processor = createMensagensDispatchProcessor({
    sender: async (payload) => {
      sent.push(payload);
      return { status: 200, data: { key: { id: "m" } } };
    },
    dispatchLogs: {
      findById: async () => ({ id: "log-1", campaign_id: CAMPAIGN_UUID }),
      updateStatus: async () => ({}),
      claimForSend: async () => ({ id: "log-1" }),
      updatePlannedSchedule: async () => ({}),
      cancelIfPending: async () => ({ id: "log-1" }),
      updateProviderDelivery: async () => ({}),
    },
    campaignsRepository: { findById: async (id) => ({ id, status: "cancelado" }) },
    logger: silentLogger,
  });

  const job = createFakeJob({
    group_id: "120363000000000000@g.us",
    message: "Mensagem antiga",
    scheduled_at: minutesAgoIso(1),
    dispatch_log_id: "log-1",
  });

  const result = await processor(job);

  assert.equal(sent.length, 0, "mensagem de campanha cancelada nao pode sair");
  assert.equal(result.status, "skipped_cancelled");
}

// Mensagem pontual sem scheduled_at: falha fechado.
async function testMensagemPontualSemHorarioNaoSai() {
  const sent = [];
  const processor = createMensagensDispatchProcessor({
    sender: async (payload) => {
      sent.push(payload);
      return { status: 200, data: { key: { id: "m" } } };
    },
    dispatchLogs: { updateStatus: async () => ({}), cancelIfPending: async () => ({ id: "log-1" }) },
    campaignsRepository: { findById: async () => null },
    logger: silentLogger,
  });

  const job = createFakeJob({ group_id: "120363000000000000@g.us", message: "Sem horario" });

  const result = await processor(job);

  assert.equal(sent.length, 0, "mensagem sem horario planejado nao pode sair");
  assert.equal(result.status, "cancelado");
}

// ---------------------------------------------------------------------------
// P3 - o sweep de retry apagando a evidencia de atraso
// ---------------------------------------------------------------------------

// Antes, buildRetryJobData estampava `scheduled_at: new Date()`: o log "falhou"
// de dias atras voltava para a fila parecendo recem-agendado, e a trava de
// atraso passava a comparar o horario contra ele mesmo.
async function testRetryPreservaHorarioOriginalDoLog() {
  const original = daysAgoIso(3);
  const data = buildRetryJobData({
    id: "log-1",
    campaign_id: CAMPAIGN_UUID,
    group_id: GROUP_UUID,
    video_id: VIDEO_UUID,
    horario_envio_planejado: original,
    groups: { evolution_group_id: "120363000000000000@g.us", trilha_id: "trilha-1" },
    video_catalog: { drive_file_id: "drive-1" },
  });

  assert.equal(data.scheduled_at, original, "retry nao pode reestampar o horario e apagar o atraso");
}

// Sem horario nenhum para ancorar, o sweep pula em vez de inventar "agora".
async function testSweepPulaLogSemHorarioEmVezDeInventar() {
  const enqueued = [];
  const marked = [];
  const result = await createDispatchFailureRetryProcessor({
    dispatchLogsRepository: {
      listFailedForRetry: async () => [
        {
          id: "log-sem-horario",
          campaign_id: CAMPAIGN_UUID,
          group_id: GROUP_UUID,
          video_id: VIDEO_UUID,
          retry_count: 0,
          groups: { evolution_group_id: "120363000000000000@g.us" },
          video_catalog: { drive_file_id: "drive-1" },
        },
      ],
      markRetrying: async (id, retryCount) => {
        marked.push({ id, retryCount });
        return { id };
      },
    },
    groupsRepository: { findById: async () => null },
    campaignsRepository: { findById: async (id) => ({ id, status: "programado" }) },
    settingsService: { getDispatchRulesSettings: async () => ({ auto_retry_failures: true }) },
    enqueueDispatch: async (data) => enqueued.push(data),
    logger: silentLogger,
  })();

  assert.equal(enqueued.length, 0, "log sem horario nao pode ser reenfileirado as cegas");
  assert.deepEqual(marked, [], "nao pode voltar o log para pendente");
  assert.equal(result.retried, 0);
}

// Guarda existente sem cobertura: o sweep nao pode driblar a acao manual do
// operador reenviando falha de campanha pausada/cancelada.
async function testSweepIgnoraCampanhaCanceladaOuPausada() {
  for (const status of ["cancelado", "pausado"]) {
    const enqueued = [];
    const result = await createDispatchFailureRetryProcessor({
      dispatchLogsRepository: {
        listFailedForRetry: async () => [
          {
            id: "log-1",
            campaign_id: CAMPAIGN_UUID,
            group_id: GROUP_UUID,
            video_id: VIDEO_UUID,
            retry_count: 0,
            horario_envio_planejado: minutesAgoIso(2),
            groups: { evolution_group_id: "120363000000000000@g.us" },
            video_catalog: { drive_file_id: "drive-1" },
          },
        ],
        markRetrying: async (id) => ({ id }),
      },
      groupsRepository: { findById: async () => null },
      campaignsRepository: { findById: async (id) => ({ id, status }) },
      settingsService: { getDispatchRulesSettings: async () => ({ auto_retry_failures: true }) },
      enqueueDispatch: async (data) => enqueued.push(data),
      logger: silentLogger,
    })();

    assert.equal(enqueued.length, 0, `campanha ${status} nao pode ser reprocessada pelo sweep`);
    assert.equal(result.retried, 0);
  }
}

// ---------------------------------------------------------------------------
// P4 - review-timeout ressuscitando campanha abandonada
// ---------------------------------------------------------------------------

// confirmDispatch monta uma janela NOVA ("agora + alguns minutos"), entao uma
// campanha abandonada em gerando_legendas ha dias era disparada inteira - e o
// sweep e re-registrado a cada start dos workers, repetindo isso em todo boot.
async function testReviewTimeoutNaoRessuscitaCampanhaAbandonada() {
  const confirmCalls = [];
  const result = await createDispatchReviewTimeoutProcessor({
    campaignsRepository: {
      listByStatusOlderThan: async () => [
        { id: CAMPAIGN_UUID, status: "gerando_legendas", status_changed_at: daysAgoIso(5) },
      ],
    },
    settingsService: {
      getDispatchRulesSettings: async () => ({ auto_send_after_timeout: { enabled: true, minutes: 60 } }),
    },
    campaignsService: {
      confirmDispatch: async (id) => {
        confirmCalls.push(id);
        return { id };
      },
    },
    logger: silentLogger,
  })();

  assert.equal(confirmCalls.length, 0, "campanha abandonada ha dias nao pode ser auto-confirmada no boot");
  assert.equal(result.confirmed, 0);
  assert.equal(result.skipped_too_old, 1);
}

// O caso legitimo continua funcionando: revisor humano nao respondeu no prazo.
async function testReviewTimeoutAindaConfirmaCampanhaRecemTravada() {
  const confirmCalls = [];
  const result = await createDispatchReviewTimeoutProcessor({
    campaignsRepository: {
      listByStatusOlderThan: async () => [
        { id: CAMPAIGN_UUID, status: "gerando_legendas", status_changed_at: minutesAgoIso(90) },
      ],
    },
    settingsService: {
      getDispatchRulesSettings: async () => ({ auto_send_after_timeout: { enabled: true, minutes: 60 } }),
    },
    campaignsService: {
      confirmDispatch: async (id) => {
        confirmCalls.push(id);
        return { id };
      },
    },
    logger: silentLogger,
  })();

  assert.deepEqual(confirmCalls, [CAMPAIGN_UUID], "timeout de revisao legitimo precisa continuar confirmando");
  assert.equal(result.confirmed, 1);
}

async function main() {
  await testJobDeDiasAtrasNaoChamaOSender();
  await testJobVencidoSemConsistenciaTambemNaoEnvia();
  await testJobSemHorarioNaoEnvia();
  await testBootStormNaoEnviaNenhumaMensagem();
  await testJobRecenteAindaEnviaNormalmente();
  await testTriggerVencidoNaoEnfileiraNadaNemNotifica();
  await testTriggerRecorrenteNaoEBloqueadoPelaJanelaAntiga();
  await testTriggerComJanelaHoraSoltaUsaExecutionAt();
  await testConsistencyUsaHorarioDoJobQuandoLogNaoTem();
  await testCampanhaCanceladaNaoEnviaMesmoComJobNaFila();
  await testCampanhaCanceladaBloqueiaTambemSemConsistencia();
  await testMensagemPontualDeCampanhaCanceladaNaoSai();
  await testMensagemPontualSemHorarioNaoSai();
  await testRetryPreservaHorarioOriginalDoLog();
  await testSweepPulaLogSemHorarioEmVezDeInventar();
  await testSweepIgnoraCampanhaCanceladaOuPausada();
  await testReviewTimeoutNaoRessuscitaCampanhaAbandonada();
  await testReviewTimeoutAindaConfirmaCampanhaRecemTravada();

  console.log("dispatch-boot-replay tests OK");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueueInfrastructure();
  });
