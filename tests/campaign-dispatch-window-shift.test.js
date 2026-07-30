const assert = require("node:assert/strict");

const { createCampaignsService } = require("../src/services/campaigns.service");
const { createCampaignTriggerProcessor } = require("../src/queues/campaign-trigger");
const { closeQueueInfrastructure } = require("../src/queues/bullmq");

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;

function createConfirmDispatchHarness(plannedSchedule = []) {
  const scheduleParams = [];
  const triggerJobs = [];
  const campaignUpdates = [];

  const service = createCampaignsService({
    repository: {
      findById: async (id) => ({ id, trilha: "Campanha do dia", status: "gerando_legendas" }),
      update: async (id, payload) => {
        campaignUpdates.push({ id, payload });
        return { id, ...payload };
      },
    },
    campaignVideoCaptionsService: {
      getCaptionProgress: async () => ({ total: 1, gerado: 1, pendente: 0 }),
    },
    settingsService: {
      getScheduleSettings: async () => ({ timezone: "America/Bahia", min_interval_min: 6, max_interval_min: 20 }),
    },
    createPendingDispatchLogsForCampaign: async (campaignId, params) => {
      scheduleParams.push({ campaignId, params });
      return { pending_logs_created: plannedSchedule.length, planned_schedule: plannedSchedule };
    },
    addCampaignTriggerJob: async (payload) => {
      triggerJobs.push(payload);
      return { id: `trigger-${triggerJobs.length}`, name: "trigger-campaign", queueName: "campaign-trigger", data: payload };
    },
  });

  return { service, scheduleParams, triggerJobs, campaignUpdates };
}

// Cenario do bug: a janela 07:00-10:00 foi configurada na Etapa 1, o usuario
// esperou as legendas serem geradas e so confirmou o envio 10 minutos depois do
// inicio. A janela precisa deslizar inteira para agora + 5 min, preservando a
// duracao, em vez de comecar no passado e perder o tempo gasto na revisao.
async function testConfirmDispatchShiftsWindowWhenStartAlreadyPassed() {
  const { service, scheduleParams, triggerJobs, campaignUpdates } = createConfirmDispatchHarness();
  const startedAt = new Date(Date.now() - 10 * 60 * 1000);
  const endedAt = new Date(startedAt.getTime() + THREE_HOURS_MS);
  const confirmedAt = Date.now();

  const result = await service.confirmDispatch("campaign-1", {
    execution_at: startedAt.toISOString(),
    time_window: { start: startedAt.toISOString(), end: endedAt.toISOString() },
    jitter_delay_min_ms: 6 * 60000,
    jitter_delay_max_ms: 20 * 60000,
  });

  const shiftedStart = new Date(result.dispatch_window.start).getTime();
  const shiftedEnd = new Date(result.dispatch_window.end).getTime();

  assert.ok(
    Math.abs(shiftedStart - (confirmedAt + FIVE_MINUTES_MS)) < 5000,
    "o inicio da janela deve ir para agora + 5 minutos"
  );
  assert.equal(shiftedEnd - shiftedStart, THREE_HOURS_MS, "a duracao da janela deve ser preservada");
  assert.equal(shiftedEnd - endedAt.getTime(), result.dispatch_window.shift_ms, "o fim recebe o mesmo deslocamento");
  assert.ok(result.dispatch_window.shift_ms > 10 * 60000, "o deslocamento inclui o tempo gasto na revisao + 5 min");

  // Os horarios sorteados e o proprio trigger seguem a janela nova: o delay de
  // cada grupo conta a partir do novo inicio, nao do horario configurado antes.
  assert.equal(scheduleParams[0].params.window_start, result.dispatch_window.start);
  assert.equal(scheduleParams[0].params.window_end, result.dispatch_window.end);
  assert.equal(triggerJobs[0].window_start, result.dispatch_window.start);
  assert.equal(triggerJobs[0].window_end, result.dispatch_window.end);
  assert.equal(new Date(triggerJobs[0].execution_at).getTime(), shiftedStart);

  const campaignUpdate = campaignUpdates.find((update) => update.payload.status === "programado");
  assert.equal(campaignUpdate.payload.window_start, result.dispatch_window.start);
  assert.equal(campaignUpdate.payload.window_end, result.dispatch_window.end);
}

async function testConfirmDispatchKeepsFutureWindowUntouched() {
  const { service, triggerJobs } = createConfirmDispatchHarness();
  const startedAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const endedAt = new Date(startedAt.getTime() + THREE_HOURS_MS);

  const result = await service.confirmDispatch("campaign-1", {
    execution_at: startedAt.toISOString(),
    time_window: { start: startedAt.toISOString(), end: endedAt.toISOString() },
    jitter_delay_min_ms: 6 * 60000,
    jitter_delay_max_ms: 20 * 60000,
  });

  assert.equal(result.dispatch_window.shift_ms, 0);
  assert.equal(result.dispatch_window.start, startedAt.toISOString());
  assert.equal(result.dispatch_window.end, endedAt.toISOString());
  assert.equal(triggerJobs[0].execution_at, startedAt.toISOString());
}

async function testConfirmDispatchForwardsDrawnScheduleToTrigger() {
  const plannedSchedule = [
    { group_id: "group-1", video_id: "video-1", scheduled_at: "2026-07-30T13:11:00.000Z", dispatch_order: 1 },
  ];
  const { service, triggerJobs } = createConfirmDispatchHarness(plannedSchedule);

  await service.confirmDispatch("campaign-1", {
    execution_at: new Date().toISOString(),
    time_window: { start: new Date().toISOString(), end: new Date(Date.now() + THREE_HOURS_MS).toISOString() },
  });

  assert.deepEqual(triggerJobs[0].precomputed_schedule, plannedSchedule);
}

// Sem o sorteio ja resolvido na confirmacao, o worker sorteava horarios novos --
// o relatorio operacional mostrava um horario e o envio saia em outro.
async function testProcessorReusesPrecomputedScheduleInsteadOfDrawingAgain() {
  const dispatchJobs = [];
  let jitteredCalls = 0;
  const processor = createCampaignTriggerProcessor({
    logger: {},
    campaigns: { findById: async (id) => ({ id, nome: "Pre infancia" }) },
    campaignVideoCaptionsRepository: { listByCampaign: async () => [] },
    dispatchLogs: null,
    whatsappInstancesRepository: { listActive: async () => [] },
    whatsappInstancesService: {
      filterDispatchableGroups: async (groupIds) => ({ eligible: groupIds, ineligible: [] }),
      getRotationSettings: async () => ({ whatsapp_rotation_group_count: 1 }),
    },
    campaignGroups: {
      listGroups: async () => [
        {
          groups: {
            id: "group-1",
            evolution_group_id: "group-1@g.us",
            trilha_id: "trilha-1",
            envia_video: true,
          },
        },
      ],
    },
    videoFlowRepository: {
      findNextApprovedUnsentVideoForGroup: async () => ({
        id: "video-1",
        drive_file_id: "drive-1",
        status: true,
        legenda: "Legenda",
      }),
    },
    addDispatchJob: async (payload) => {
      dispatchJobs.push(payload);
      return { id: `dispatch-${dispatchJobs.length}`, data: payload };
    },
    addJitteredDispatchJobs: async () => {
      jitteredCalls += 1;
      return [];
    },
  });

  const result = await processor({
    id: "job-1",
    data: {
      campaign_id: "campaign-1",
      execution_at: "2026-07-30T10:00:00.000Z",
      time_window: { start: "2026-07-30T10:00:00.000Z", end: "2026-07-30T13:00:00.000Z" },
      dispatch_jitter: { min_ms: 6 * 60000, max_ms: 20 * 60000 },
      precomputed_schedule: [
        { group_id: "group-1", video_id: "video-1", scheduled_at: "2026-07-30T10:07:00.000Z", dispatch_order: 1 },
      ],
    },
    async updateData(nextData) {
      this.data = nextData;
    },
  });

  assert.equal(jitteredCalls, 0, "o worker nao deve sortear horarios de novo");
  assert.equal(dispatchJobs.length, 1);
  assert.equal(dispatchJobs[0].scheduled_at, "2026-07-30T10:07:00.000Z");
  assert.equal(dispatchJobs[0].dispatch_order, 1);
  assert.equal(result.dispatch_enqueued, 1);
}

// Se a lista de grupos mudou entre a confirmacao e a execucao, o sorteio
// guardado nao cobre todo mundo e o caminho normal com jitter volta a valer.
async function testProcessorFallsBackToJitterWhenPrecomputedScheduleIsIncomplete() {
  let jitteredCalls = 0;
  const processor = createCampaignTriggerProcessor({
    logger: {},
    campaigns: { findById: async (id) => ({ id, nome: "Pre infancia" }) },
    campaignVideoCaptionsRepository: { listByCampaign: async () => [] },
    dispatchLogs: null,
    whatsappInstancesRepository: { listActive: async () => [] },
    whatsappInstancesService: {
      filterDispatchableGroups: async (groupIds) => ({ eligible: groupIds, ineligible: [] }),
      getRotationSettings: async () => ({ whatsapp_rotation_group_count: 1 }),
    },
    campaignGroups: {
      listGroups: async () => [
        { groups: { id: "group-1", evolution_group_id: "group-1@g.us", trilha_id: "trilha-1", envia_video: true } },
        { groups: { id: "group-2", evolution_group_id: "group-2@g.us", trilha_id: "trilha-1", envia_video: true } },
      ],
    },
    videoFlowRepository: {
      findNextApprovedUnsentVideoForGroup: async () => ({
        id: "video-1",
        drive_file_id: "drive-1",
        status: true,
        legenda: "Legenda",
      }),
    },
    addDispatchJob: async (payload) => ({ id: "dispatch-1", data: payload }),
    addJitteredDispatchJobs: async () => {
      jitteredCalls += 1;
      return [{ id: "dispatch-1", data: {} }, { id: "dispatch-2", data: {} }];
    },
  });

  await processor({
    id: "job-1",
    data: {
      campaign_id: "campaign-1",
      execution_at: "2026-07-30T10:00:00.000Z",
      time_window: { start: "2026-07-30T10:00:00.000Z", end: "2026-07-30T13:00:00.000Z" },
      dispatch_jitter: { min_ms: 6 * 60000, max_ms: 20 * 60000 },
      precomputed_schedule: [
        { group_id: "group-1", video_id: "video-1", scheduled_at: "2026-07-30T10:07:00.000Z", dispatch_order: 1 },
      ],
    },
    async updateData(nextData) {
      this.data = nextData;
    },
  });

  assert.equal(jitteredCalls, 1);
}

async function main() {
  await testConfirmDispatchShiftsWindowWhenStartAlreadyPassed();
  await testConfirmDispatchKeepsFutureWindowUntouched();
  await testConfirmDispatchForwardsDrawnScheduleToTrigger();
  await testProcessorReusesPrecomputedScheduleInsteadOfDrawingAgain();
  await testProcessorFallsBackToJitterWhenPrecomputedScheduleIsIncomplete();

  await closeQueueInfrastructure();

  console.log("campaign-dispatch-window-shift tests OK");
}

main().catch(async (error) => {
  console.error(error);
  await closeQueueInfrastructure().catch(() => undefined);
  process.exitCode = 1;
});
