const assert = require("node:assert/strict");

const { createCampaignsService } = require("../src/services/campaigns.service");

function buildLog(overrides = {}) {
  return {
    id: "log-1",
    campaign_id: "campaign-1",
    group_id: "group-1",
    video_id: "video-1",
    status: "pendente",
    horario_envio_planejado: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function buildHarness(overrides = {}) {
  const updates = [];
  const plannedScheduleUpdates = [];
  const cancelCalls = [];
  const campaignsById = new Map((overrides.campaigns || []).map((c) => [c.id, { ...c }]));

  const repository = {
    async findById(id) {
      return campaignsById.get(id) || null;
    },
    async update(id, payload) {
      const current = campaignsById.get(id) || { id };
      const next = { ...current, ...payload };
      campaignsById.set(id, next);
      updates.push({ id, payload });
      return next;
    },
    async listActiveOverlappingWindow() {
      return overrides.overlapping || [];
    },
  };

  const dispatchLogsRepository = {
    pendingLogs: overrides.pendingLogs || [],
    async listPendingByCampaign() {
      return this.pendingLogs;
    },
    async updatePlannedSchedule(id, horario) {
      plannedScheduleUpdates.push({ id, horario });
      const log = this.pendingLogs.find((entry) => entry.id === id);
      return log ? { ...log, horario_envio_planejado: horario } : null;
    },
    async cancelPendingByCampaign(campaignId) {
      cancelCalls.push(campaignId);
      return this.pendingLogs.filter((entry) => entry.status === "pendente");
    },
  };

  const campaignGroupsRepository = {
    async listGroups() {
      return (overrides.groupIds || ["group-1"]).map((groupId) => ({ group_id: groupId }));
    },
  };

  const service = createCampaignsService({
    repository,
    campaignGroupsRepository,
    dispatchLogsRepository,
    settingsService: { async getScheduleSettings() { return {}; } },
    addCampaignTriggerJob: overrides.addCampaignTriggerJob || (async () => ({ id: "new-trigger-job" })),
    requeuePendingDispatchJobsForCampaign: overrides.requeuePendingDispatchJobsForCampaign,
    mensagensService: overrides.mensagensService,
    campaignTriggerQueue: overrides.campaignTriggerQueue,
    dispatchQueue: overrides.dispatchQueue,
    mensagensDispatchQueue: overrides.mensagensDispatchQueue,
  });

  return { service, repository, updates, plannedScheduleUpdates, cancelCalls, campaignsById };
}

async function testPauseRejectsWhenNotProgramado() {
  const { service } = buildHarness({
    campaigns: [{ id: "campaign-1", status: "gerando_legendas" }],
  });

  await assert.rejects(
    () => service.pauseCampaign("campaign-1"),
    (error) => {
      assert.equal(error.code, "CAMPAIGN_NOT_PAUSABLE");
      return true;
    }
  );
}

async function testPauseRejectsWhenNothingPending() {
  const { service } = buildHarness({
    campaigns: [{ id: "campaign-1", status: "programado" }],
    pendingLogs: [],
  });

  await assert.rejects(
    () => service.pauseCampaign("campaign-1"),
    (error) => {
      assert.equal(error.code, "CAMPAIGN_NOT_PAUSABLE");
      return true;
    }
  );
}

async function testPauseSucceeds() {
  const { service, updates } = buildHarness({
    campaigns: [{ id: "campaign-1", status: "programado" }],
    pendingLogs: [buildLog()],
  });

  const result = await service.pauseCampaign("campaign-1");

  assert.equal(result.status, "pausado");
  assert.ok(result.paused_at);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].payload.status, "pausado");
}

async function testResumeRejectsWhenNotPausado() {
  const { service } = buildHarness({
    campaigns: [{ id: "campaign-1", status: "programado" }],
  });

  await assert.rejects(
    () => service.resumeCampaign("campaign-1"),
    (error) => {
      assert.equal(error.code, "CAMPAIGN_NOT_PAUSED");
      return true;
    }
  );
}

// Caso (a): trigger de video ainda nao tinha disparado - o job original ainda
// esta "delayed" no Redis, entao o resume deve reagenda-lo (changeDelay) em vez
// de criar um novo.
async function testResumeVideoTriggerNotFiredRechedulesSurvivingJob() {
  const pausedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const windowStart = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const windowEnd = new Date(Date.now() + 65 * 60 * 1000).toISOString();
  const changeDelayCalls = [];
  const updateDataCalls = [];

  const triggerJob = {
    data: { campaign_id: "campaign-1" },
    async getState() {
      return "delayed";
    },
    async changeDelay(ms) {
      changeDelayCalls.push(ms);
    },
    async updateData(data) {
      updateDataCalls.push(data);
    },
  };

  const { service, updates } = buildHarness({
    campaigns: [
      {
        id: "campaign-1",
        status: "pausado",
        tipo: "trilha",
        paused_at: pausedAt,
        window_start: windowStart,
        window_end: windowEnd,
        trigger_fired_at: null,
        campaign_trigger_job_id: "trigger-job-1",
        total_paused_ms: 0,
      },
    ],
    pendingLogs: [buildLog()],
    campaignTriggerQueue: {
      async getJob(id) {
        assert.equal(id, "trigger-job-1");
        return triggerJob;
      },
    },
  });

  const before = Date.now();
  const result = await service.resumeCampaign("campaign-1");
  const after = Date.now();

  assert.equal(result.status, "programado");
  assert.equal(result.paused_at, null);
  assert.equal(changeDelayCalls.length, 1);
  assert.equal(updateDataCalls.length, 1);
  assert.ok(Array.isArray(updateDataCalls[0].precomputed_schedule));

  const shiftMs = new Date(result.window_start).getTime() - new Date(windowStart).getTime();
  assert.ok(shiftMs >= after - before, "janela deve deslocar pelo menos o tempo de pausa decorrido");
  assert.ok(shiftMs < 6 * 60 * 1000, "deslocamento nao pode ser muito maior que o tempo pausado");
  assert.equal(updates[updates.length - 1].payload.status, "programado");
}

// Caso (b): trigger ja tinha disparado e o job de dispatch do grupo sobreviveu
// no Redis - reagenda (changeDelay) em vez de recriar.
async function testResumeVideoDispatchJobSurvivingGetsRescheduled() {
  const pausedAt = new Date(Date.now() - 60 * 1000).toISOString();
  const changeDelayCalls = [];
  let requeueCalled = false;

  const dispatchJob = {
    async getState() {
      return "delayed";
    },
    async changeDelay(ms) {
      changeDelayCalls.push(ms);
    },
  };

  const { service } = buildHarness({
    campaigns: [
      {
        id: "campaign-1",
        status: "pausado",
        tipo: "trilha",
        paused_at: pausedAt,
        window_start: null,
        window_end: null,
        trigger_fired_at: new Date().toISOString(),
        total_paused_ms: 0,
      },
    ],
    pendingLogs: [buildLog({ dispatch_job_id: "dispatch-job-1" })],
    dispatchQueue: {
      async getJob(id) {
        assert.equal(id, "dispatch-job-1");
        return dispatchJob;
      },
    },
    requeuePendingDispatchJobsForCampaign: async () => {
      requeueCalled = true;
      return [];
    },
  });

  await service.resumeCampaign("campaign-1");

  assert.equal(changeDelayCalls.length, 1);
  assert.equal(requeueCalled, false, "nao deve recriar um job que ainda sobrevive no Redis");
}

// Job do log nao existe mais (ja tinha disparado-e-virado-no-op durante a
// pausa) - precisa recriar via requeuePendingDispatchJobsForCampaign.
async function testResumeVideoDispatchJobMissingIsRequeued() {
  const pausedAt = new Date(Date.now() - 60 * 1000).toISOString();
  let requeuedLogs = null;

  const { service } = buildHarness({
    campaigns: [
      {
        id: "campaign-1",
        status: "pausado",
        tipo: "trilha",
        paused_at: pausedAt,
        window_start: null,
        window_end: null,
        trigger_fired_at: new Date().toISOString(),
        total_paused_ms: 0,
      },
    ],
    pendingLogs: [buildLog({ dispatch_job_id: "dispatch-job-missing" })],
    dispatchQueue: {
      async getJob() {
        return null;
      },
    },
    requeuePendingDispatchJobsForCampaign: async (campaignId, logs) => {
      requeuedLogs = { campaignId, logs };
      return [];
    },
  });

  await service.resumeCampaign("campaign-1");

  assert.ok(requeuedLogs);
  assert.equal(requeuedLogs.campaignId, "campaign-1");
  assert.equal(requeuedLogs.logs.length, 1);
  assert.equal(requeuedLogs.logs[0].id, "log-1");
}

// Campanha pontual: sem job sobrevivente, delega para
// mensagensService.requeuePendingMessages em vez do caminho de video.
async function testResumeTextCampaignDelegatesToMensagensService() {
  const pausedAt = new Date(Date.now() - 60 * 1000).toISOString();
  let requeuedArgs = null;

  const { service } = buildHarness({
    campaigns: [
      {
        id: "campaign-1",
        status: "pausado",
        tipo: "pontual",
        paused_at: pausedAt,
        window_start: null,
        window_end: null,
        trigger_fired_at: new Date().toISOString(),
        texto_mensagem: "Ola",
        total_paused_ms: 0,
      },
    ],
    pendingLogs: [buildLog({ video_id: null, dispatch_job_id: "mensagens-job-1" })],
    mensagensDispatchQueue: {
      async getJob() {
        return null;
      },
    },
    mensagensService: {
      async requeuePendingMessages(campaign, logs) {
        requeuedArgs = { campaign, logs };
        return [];
      },
    },
  });

  await service.resumeCampaign("campaign-1");

  assert.ok(requeuedArgs);
  assert.equal(requeuedArgs.campaign.id, "campaign-1");
  assert.equal(requeuedArgs.logs.length, 1);
}

// Dados antigos (campanha pontual criada antes de scheduleAdHoc gravar
// trigger_fired_at) nao podem cair no ramo de video so por causa do nulo.
async function testResumeTextCampaignWithNullTriggerFiredAtStillUsesTextPath() {
  const pausedAt = new Date(Date.now() - 60 * 1000).toISOString();
  let requeuedArgs = null;
  let triggerCalled = false;

  const { service } = buildHarness({
    campaigns: [
      {
        id: "campaign-1",
        status: "pausado",
        tipo: "pontual",
        paused_at: pausedAt,
        window_start: null,
        window_end: null,
        trigger_fired_at: null,
        texto_mensagem: "Ola",
        total_paused_ms: 0,
      },
    ],
    pendingLogs: [buildLog({ video_id: null, dispatch_job_id: null })],
    addCampaignTriggerJob: async () => {
      triggerCalled = true;
      return { id: "should-not-be-created" };
    },
    mensagensDispatchQueue: {
      async getJob() {
        return null;
      },
    },
    mensagensService: {
      async requeuePendingMessages(campaign, logs) {
        requeuedArgs = { campaign, logs };
        return [];
      },
    },
  });

  await service.resumeCampaign("campaign-1");

  assert.equal(triggerCalled, false, "campanha pontual nao pode enfileirar campaign-trigger");
  assert.ok(requeuedArgs, "deve delegar para mensagensService mesmo sem trigger_fired_at");
}

async function testCancelMarksPendingLogsAndCampaign() {
  const { service, updates, cancelCalls } = buildHarness({
    campaigns: [{ id: "campaign-1", status: "programado" }],
    pendingLogs: [buildLog()],
  });

  const result = await service.cancelCampaign("campaign-1");

  assert.equal(result.status, "cancelado");
  assert.equal(cancelCalls.length, 1);
  assert.equal(updates[updates.length - 1].payload.status, "cancelado");
  // ativo: false junto com o status. Gravar so o status deixava a campanha
  // dentro de listActiveOverlappingWindow (que filtra por ativo, nao por
  // status), e ela seguia bloqueando aquela janela+grupos para sempre - todo
  // disparo pontual novo no mesmo horario batia em 409 apontando para uma
  // campanha ja cancelada.
  assert.equal(
    updates[updates.length - 1].payload.ativo,
    false,
    "cancelamento precisa desativar a campanha para ela sair da checagem de conflito de janela"
  );
}

async function testCancelIsIdempotent() {
  const { service, cancelCalls } = buildHarness({
    campaigns: [{ id: "campaign-1", status: "cancelado" }],
  });

  const result = await service.cancelCampaign("campaign-1");

  assert.equal(result.status, "cancelado");
  assert.equal(cancelCalls.length, 0, "nao deve tentar cancelar logs de novo");
}

async function testCancelRejectsWhenConcluido() {
  const { service } = buildHarness({
    campaigns: [{ id: "campaign-1", status: "concluido" }],
  });

  await assert.rejects(
    () => service.cancelCampaign("campaign-1"),
    (error) => {
      assert.equal(error.code, "CAMPAIGN_NOT_CANCELABLE");
      return true;
    }
  );
}

async function testConfirmDispatchRejectsWhenCancelled() {
  const { service } = buildHarness({
    campaigns: [{ id: "campaign-1", status: "cancelado" }],
  });

  await assert.rejects(
    () => service.confirmDispatch("campaign-1", {}),
    (error) => {
      assert.equal(error.code, "CAMPAIGN_CANCELLED");
      return true;
    }
  );
}

async function main() {
  await testPauseRejectsWhenNotProgramado();
  await testPauseRejectsWhenNothingPending();
  await testPauseSucceeds();
  await testResumeRejectsWhenNotPausado();
  await testResumeVideoTriggerNotFiredRechedulesSurvivingJob();
  await testResumeVideoDispatchJobSurvivingGetsRescheduled();
  await testResumeVideoDispatchJobMissingIsRequeued();
  await testResumeTextCampaignDelegatesToMensagensService();
  await testResumeTextCampaignWithNullTriggerFiredAtStillUsesTextPath();
  await testCancelMarksPendingLogsAndCampaign();
  await testCancelIsIdempotent();
  await testCancelRejectsWhenConcluido();
  await testConfirmDispatchRejectsWhenCancelled();

  console.log("campaign-pause-resume tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
