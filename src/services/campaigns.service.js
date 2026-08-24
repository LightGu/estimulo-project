const campaignsRepository = require("../repositories/campaigns.repository");
const campaignGroupsRepository = require("../repositories/campaign-groups.repository");
const groupsRepository = require("../repositories/groups.repository");
const dispatchLogsRepository = require("../repositories/dispatch-logs.repository");
const defaultCampaignVideoCaptionsService = require("./campaign-video-captions.service");
const defaultSettingsService = require("./settings.service");
const defaultMensagensService = require("./mensagens.service");
const defaultWhatsappInstancesService = require("./whatsapp-instances.service");
const { assertNoCampaignWindowConflict } = require("./campaign-window-conflict");
const { resolveLogScheduledAt } = require("./dispatch-staleness");
// Modulos inteiros (nao desestruturados): campaignTriggerQueue/dispatchQueue/
// mensagensDispatchQueue sao getters que criam a conexao BullMQ na primeira
// leitura - desestruturar aqui no topo do arquivo criaria as 3 filas so por
// importar campaigns.service.js, mesmo em contexto que nunca chega a usa-las.
const campaignTriggerQueueModule = require("../queues/campaign-trigger");
const dispatchQueueModule = require("../queues/dispatch");
const mensagensDispatchQueueModule = require("../queues/mensagens-dispatch");
const {
  addCampaignTriggerJob,
  createPendingDispatchLogsForCampaign: defaultCreatePendingDispatchLogsForCampaign,
  requeuePendingDispatchJobsForCampaign: defaultRequeuePendingDispatchJobsForCampaign,
} = campaignTriggerQueueModule;
const { formatCampaignDayName, formatDateOnlyInTimezone } = require("../utils/campaign-naming");

const TRIGGER_ENQUEUE_TIMEOUT_MS = Number(process.env.CAMPAIGN_TRIGGER_ENQUEUE_TIMEOUT_MS) || 5000;
const DISPATCH_CONFIRM_LEAD_MS = Number(process.env.CAMPAIGN_DISPATCH_CONFIRM_LEAD_MS) || 5 * 60 * 1000;

function withTimeout(promise, timeoutMs, timeoutMessage) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)),
  ]);
}

function normalizeScheduledDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error("Execution date is invalid");
  }

  return date;
}

function normalizeNumber(value, defaultValue) {
  const number = Number(value ?? defaultValue);

  return Number.isFinite(number) ? Math.trunc(number) : defaultValue;
}

function resolveDispatchScheduleOptions(payload = {}, executionDate = new Date(), scheduleSettings = {}) {
  const defaultWindowEnd = new Date(executionDate.getTime() + 60 * 60 * 1000);
  const windowStart =
    payload.window_start ||
    payload.windowStart ||
    payload.time_window?.start ||
    payload.timeWindow?.start ||
    process.env.CAMPAIGN_DISPATCH_WINDOW_START ||
    executionDate.toISOString();
  const windowEnd =
    payload.window_end ||
    payload.windowEnd ||
    payload.time_window?.end ||
    payload.timeWindow?.end ||
    process.env.CAMPAIGN_DISPATCH_WINDOW_END ||
    defaultWindowEnd.toISOString();
  const defaultMinMs = Number.isInteger(scheduleSettings.min_interval_min)
    ? scheduleSettings.min_interval_min * 60000
    : 60000;
  const defaultMaxMs = Number.isInteger(scheduleSettings.max_interval_min)
    ? scheduleSettings.max_interval_min * 60000
    : 300000;
  const jitterMin = payload.jitter_delay_min_ms ?? payload.jitterDelayMinMs ?? process.env.CAMPAIGN_DISPATCH_JITTER_MIN_MS;
  const jitterMax = payload.jitter_delay_max_ms ?? payload.jitterDelayMaxMs ?? process.env.CAMPAIGN_DISPATCH_JITTER_MAX_MS;
  const minMs = normalizeNumber(jitterMin, defaultMinMs);
  const maxMs = normalizeNumber(jitterMax, defaultMaxMs);

  return {
    window_start: windowStart,
    window_end: windowEnd,
    jitter_delay_min_ms: minMs,
    jitter_delay_max_ms: Math.max(maxMs, minMs),
  };
}

// A janela escolhida na Etapa 1 vale para o instante do disparo, mas entre
// "Disparar campanha" e "Fazer o envio" o usuario ainda espera as legendas serem
// geradas e as revisa -- o que pode levar minutos. Se o inicio da janela ja
// passou quando o envio e confirmado, o primeiro grupo cairia no passado e o
// jitter perderia exatamente o tempo gasto na revisao. Aqui a janela inteira
// desliza para frente preservando a duracao: o inicio vai para agora + 5 min e
// o fim recebe o mesmo deslocamento (janela 07:00-10:00 confirmada as 07:10 vira
// 07:15-10:15). Janela ainda no futuro nao e tocada.
function shiftDispatchWindowToConfirmation(scheduleOptions, now = new Date()) {
  const start = new Date(scheduleOptions.window_start);
  const end = new Date(scheduleOptions.window_end);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { ...scheduleOptions, window_shift_ms: 0 };
  }

  const shiftMs = now.getTime() + DISPATCH_CONFIRM_LEAD_MS - start.getTime();

  if (shiftMs <= 0) {
    return { ...scheduleOptions, window_shift_ms: 0 };
  }

  return {
    ...scheduleOptions,
    window_start: new Date(start.getTime() + shiftMs).toISOString(),
    window_end: new Date(end.getTime() + shiftMs).toISOString(),
    window_shift_ms: shiftMs,
  };
}

function normalizeGroupIds(payload = {}) {
  const groupIds = payload.group_ids || payload.groupIds || (payload.group_id ? [payload.group_id] : undefined);

  if (!Array.isArray(groupIds) || groupIds.length === 0) {
    throw new Error("At least one group id is required");
  }

  const normalized = groupIds.map((groupId) => String(groupId || "").trim()).filter(Boolean);

  if (normalized.length !== groupIds.length) {
    throw new Error("Group id is required");
  }

  return [...new Set(normalized)];
}

function createCampaignsService(dependencies = {}) {
  const repository = dependencies.repository || campaignsRepository;
  const campaignGroupsRepositoryDependency = dependencies.campaignGroupsRepository || campaignGroupsRepository;
  const groupsRepositoryDependency = dependencies.groupsRepository || groupsRepository;
  const dispatchLogsRepositoryDependency = dependencies.dispatchLogsRepository || dispatchLogsRepository;
  const campaignVideoCaptionsServiceDependency =
    dependencies.campaignVideoCaptionsService || defaultCampaignVideoCaptionsService;
  const settingsServiceDependency = dependencies.settingsService || defaultSettingsService;
  const mensagensServiceDependency = dependencies.mensagensService || defaultMensagensService;
  const whatsappInstancesServiceDependency = dependencies.whatsappInstancesService || defaultWhatsappInstancesService;
  const enqueueCampaignTrigger = dependencies.addCampaignTriggerJob || addCampaignTriggerJob;
  const requeuePendingDispatchJobs =
    dependencies.requeuePendingDispatchJobsForCampaign || defaultRequeuePendingDispatchJobsForCampaign;

  // So resolvidas quando de fato chamadas (dentro de resumeCampaign) - sao
  // getters que criam a conexao BullMQ na primeira leitura, e resumeCampaign e
  // uma acao rara, nao algo que deva acontecer so por instanciar o service.
  function getCampaignTriggerQueueDependency() {
    return dependencies.campaignTriggerQueue || campaignTriggerQueueModule.campaignTriggerQueue;
  }

  function getDispatchQueueDependency() {
    return dependencies.dispatchQueue || dispatchQueueModule.dispatchQueue;
  }

  function getMensagensDispatchQueueDependency() {
    return dependencies.mensagensDispatchQueue || mensagensDispatchQueueModule.mensagensDispatchQueue;
  }

  async function resolveScheduleSettings() {
    try {
      return await settingsServiceDependency.getScheduleSettings();
    } catch (error) {
      return {};
    }
  }
  const createPendingDispatchLogs = (campaignId, scheduleParams = {}) =>
    (dependencies.createPendingDispatchLogsForCampaign || defaultCreatePendingDispatchLogsForCampaign)(campaignId, {
      campaignGroups: campaignGroupsRepositoryDependency,
      campaigns: repository,
      dispatchLogs: dispatchLogsRepositoryDependency,
      videoCatalogRepository: dependencies.videoCatalogRepository,
      groupVideoProgressRepository: dependencies.groupVideoProgressRepository,
      inAppNotificationsService: dependencies.inAppNotificationsService,
      ...scheduleParams,
    });

  async function create(payload) {
    const trilha = (payload?.trilha || payload?.trail || payload?.nome || "").trim();

    if (!trilha) {
      throw new Error("Campaign trail is required");
    }

    return repository.create({
      ativo: payload?.ativo !== undefined ? Boolean(payload.ativo) : true,
      trilha,
      data_envio: payload?.data_envio || payload?.dataEnvio || null,
      horario_envio: payload?.horario_envio || payload?.horarioEnvio || null,
    });
  }

  // Regra compartilhada com o disparo pontual agendado - ver
  // campaign-window-conflict.js.
  async function assertNoWindowConflict(groupIds, scheduleOptions, options = {}) {
    return assertNoCampaignWindowConflict({
      campaignsRepository: repository,
      campaignGroupsRepository: campaignGroupsRepositoryDependency,
      groupIds,
      windowStart: scheduleOptions.window_start,
      windowEnd: scheduleOptions.window_end,
      excludeId: options.excludeId,
      timezone: options.timezone,
    });
  }

  async function createAndQueue(payload = {}) {
    const groupIds = normalizeGroupIds(payload);

    // Com 2+ numeros ativos, todo grupo programado precisa estar coberto por
    // TODOS eles - senao o rodizio (dispatch-jitter.js resolveInstanceForOrder)
    // manda uma rodada para um numero que nem esta naquele grupo. Bloqueia aqui,
    // na criacao da campanha, para o usuario corrigir a cobertura antes de gastar
    // legendas geradas (Etapa 2) numa campanha que so seria filtrada depois, em
    // silencio, no createPendingDispatchLogsForCampaign.
    await whatsappInstancesServiceDependency.assertGroupsDispatchable(groupIds);

    const executionDate = normalizeScheduledDate(
      payload.execution_at || payload.executionAt || payload.scheduled_at || payload.scheduledAt
    );
    const deferDispatch = Boolean(payload.defer_dispatch ?? payload.deferDispatch);

    const groups = [];

    for (const groupId of groupIds) {
      const group = await groupsRepositoryDependency.findById(groupId);

      if (!group) {
        throw new Error("Group not found");
      }

      groups.push(group);
    }

    const scheduleSettings = await resolveScheduleSettings();
    const scheduleOptions = resolveDispatchScheduleOptions(payload, executionDate, scheduleSettings);

    await assertNoWindowConflict(groupIds, scheduleOptions, {
      timezone: payload.timezone || scheduleSettings.timezone,
    });

    const campaign = await createForToday({
      reference_date: executionDate,
      schedule_settings: scheduleSettings,
      window_start: scheduleOptions.window_start,
      window_end: scheduleOptions.window_end,
    });

    if (deferDispatch && campaign.status !== "gerando_legendas") {
      await repository.update(campaign.id, { status: "gerando_legendas" });
      campaign.status = "gerando_legendas";
    }

    const existingGroupIds = new Set(
      (await campaignGroupsRepositoryDependency.listGroups(campaign.id)).map((row) => row.group_id)
    );
    const campaignGroups = [];

    for (const group of groups) {
      if (existingGroupIds.has(group.id)) {
        continue;
      }

      campaignGroups.push(
        await campaignGroupsRepositoryDependency.associateGroup(campaign.id, group.id, group.organization_id)
      );
    }

    if (deferDispatch) {
      return {
        campaign,
        campaign_groups: campaignGroups,
        trigger_job: null,
      };
    }

    const triggerJob = await enqueueCampaignTrigger(
      {
        campaign_id: campaign.id,
        execution_at: executionDate.toISOString(),
        time_window: payload.time_window || payload.timeWindow,
        dispatch_jitter: payload.dispatch_jitter || payload.dispatchJitter,
        window_start: scheduleOptions.window_start,
        window_end: scheduleOptions.window_end,
        jitter_delay_min_ms: scheduleOptions.jitter_delay_min_ms,
        jitter_delay_max_ms: scheduleOptions.jitter_delay_max_ms,
        timezone: payload.timezone || scheduleSettings.timezone,
      },
      {
        removeOnComplete: false,
        removeOnFail: false,
      }
    );

    if (triggerJob && triggerJob.id) {
      await repository.update(campaign.id, { campaign_trigger_job_id: triggerJob.id }).catch(() => undefined);
    }

    return {
      campaign,
      campaign_groups: campaignGroups,
      trigger_job: {
        id: triggerJob.id,
        name: triggerJob.name,
        queue: triggerJob.queueName,
        data: triggerJob.data,
      },
    };
  }

  async function maybeAutoConfirmDispatch(campaignId, payload) {
    let dispatchRules;

    try {
      dispatchRules = await settingsServiceDependency.getDispatchRulesSettings();
    } catch (error) {
      return;
    }

    if (dispatchRules.require_human_review !== false) {
      return;
    }

    try {
      await confirmDispatch(campaignId, payload);
    } catch (error) {
      console.error &&
        console.error(
          JSON.stringify({
            event: "campaigns.auto_confirm_dispatch_failed",
            campaign_id: campaignId,
            error_message: error.message,
          })
        );
    }
  }

  async function dispatchCampaign(payload = {}) {
    const result = await createAndQueue({ ...payload, defer_dispatch: true });

    campaignVideoCaptionsServiceDependency
      .generateCaptionsForCampaign(result.campaign.id)
      .then(() => maybeAutoConfirmDispatch(result.campaign.id, payload))
      .catch((error) => {
        console.error &&
          console.error(
            JSON.stringify({
              event: "campaign_video_captions.generation_failed",
              campaign_id: result.campaign.id,
              error_message: error.message,
            })
          );
      });

    return result;
  }

  async function confirmDispatch(campaignId, payload = {}) {
    if (!campaignId) {
      throw new Error("Campaign id is required");
    }

    const campaign = await repository.findById(campaignId);

    if (!campaign) {
      throw new Error("Campaign not found");
    }

    // Fecha a corrida entre o cancelamento e a confirmacao automatica (sweep
    // de review timeout, ou a geracao de legendas que termina depois do
    // cancelamento): sem isto, uma campanha ja cancelada podia ainda assim
    // ganhar logs novos e um job de trigger.
    if (campaign.status === "cancelado") {
      const error = new Error("Campanha foi cancelada e nao pode ser confirmada");
      error.code = "CAMPAIGN_CANCELLED";
      throw error;
    }

    const progress = await campaignVideoCaptionsServiceDependency.getCaptionProgress(campaignId);

    if (progress.pendente > 0) {
      const error = new Error("Existem legendas pendentes para esta campanha");
      error.code = "CAPTIONS_PENDING";
      throw error;
    }

    const executionDate = normalizeScheduledDate(
      payload.execution_at || payload.executionAt || payload.scheduled_at || payload.scheduledAt
    );
    const scheduleSettings = await resolveScheduleSettings();
    const scheduleOptions = shiftDispatchWindowToConfirmation(
      resolveDispatchScheduleOptions(payload, executionDate, scheduleSettings)
    );
    // O trigger acompanha a janela deslocada: e a partir do novo inicio que os
    // delays de cada grupo contam, nao do horario configurado la na Etapa 1.
    const triggerExecutionDate = new Date(executionDate.getTime() + scheduleOptions.window_shift_ms);

    const pendingLogs = await createPendingDispatchLogs(campaign.id, {
      execution_at: triggerExecutionDate.toISOString(),
      window_start: scheduleOptions.window_start,
      window_end: scheduleOptions.window_end,
      jitter_delay_min_ms: scheduleOptions.jitter_delay_min_ms,
      jitter_delay_max_ms: scheduleOptions.jitter_delay_max_ms,
    });
    const updatedCampaign = await repository.update(campaignId, {
      status: "programado",
      window_start: scheduleOptions.window_start,
      window_end: scheduleOptions.window_end,
    });

    let triggerJob = null;
    let triggerJobError = null;

    try {
      triggerJob = await withTimeout(
        enqueueCampaignTrigger(
          {
            campaign_id: campaign.id,
            execution_at: triggerExecutionDate.toISOString(),
            time_window: payload.time_window || payload.timeWindow,
            dispatch_jitter: payload.dispatch_jitter || payload.dispatchJitter,
            window_start: scheduleOptions.window_start,
            window_end: scheduleOptions.window_end,
            jitter_delay_min_ms: scheduleOptions.jitter_delay_min_ms,
            jitter_delay_max_ms: scheduleOptions.jitter_delay_max_ms,
            // Horarios sorteados agora, na confirmacao: o worker reaproveita
            // exatamente estes em vez de sortear de novo quando for executar.
            precomputed_schedule: pendingLogs && pendingLogs.planned_schedule,
            timezone: payload.timezone || scheduleSettings.timezone,
          },
          {
            removeOnComplete: false,
            removeOnFail: false,
          }
        ),
        TRIGGER_ENQUEUE_TIMEOUT_MS,
        "Timeout ao enfileirar campaign-trigger"
      );

      // Guardado para pauseCampaign/resumeCampaign conseguirem localizar este
      // job direto (queue.getJob(id)) em vez de escanear a fila.
      if (triggerJob && triggerJob.id) {
        await repository.update(campaign.id, { campaign_trigger_job_id: triggerJob.id }).catch(() => undefined);
      }
    } catch (error) {
      triggerJobError = error.message;
      console.error &&
        console.error(
          JSON.stringify({
            event: "campaigns.confirm_dispatch.trigger_enqueue_failed",
            campaign_id: campaign.id,
            error_message: error.message,
          })
        );
    }

    return {
      campaign: updatedCampaign,
      pending_logs: pendingLogs,
      dispatch_window: {
        start: scheduleOptions.window_start,
        end: scheduleOptions.window_end,
        shift_ms: scheduleOptions.window_shift_ms,
      },
      trigger_job: triggerJob && {
        id: triggerJob.id,
        name: triggerJob.name,
        queue: triggerJob.queueName,
        data: triggerJob.data,
      },
      trigger_job_error: triggerJobError,
    };
  }

  async function update(id, payload) {
    if (!id) {
      throw new Error("Campaign id is required");
    }

    if (!payload || Object.keys(payload).length === 0) {
      throw new Error("At least one field is required");
    }

    const current = await repository.findById(id);

    if (!current) {
      throw new Error("Campaign not found");
    }

    const nextPayload = { ...payload };

    if (nextPayload.nome !== undefined && nextPayload.trilha === undefined) {
      nextPayload.trilha = nextPayload.nome;
    }

    delete nextPayload.nome;

    if (nextPayload.trilha !== undefined) {
      nextPayload.trilha = nextPayload.trilha.trim();

      if (!nextPayload.trilha) {
        throw new Error("Campaign trail is required");
      }
    }

    return repository.update(id, nextPayload);
  }

  async function remove(id) {
    if (!id) {
      throw new Error("Campaign id is required");
    }

    const current = await repository.findById(id);

    if (!current) {
      throw new Error("Campaign not found");
    }

    // Apagar a campanha remove, via ON DELETE CASCADE, todo o historico de logs
    // vinculado (inclusive disparos ja enviados). Para nao destruir o historico
    // operacional, bloqueamos o delete quando ja houve pelo menos um envio.
    const logs = await dispatchLogsRepositoryDependency.listByCampaign(id);
    const hasDeliveredLogs = logs.some((log) => log.status === "enviado");

    if (hasDeliveredLogs) {
      const error = new Error("Campaign already has delivered dispatches");
      error.code = "CAMPAIGN_HAS_DELIVERIES";
      throw error;
    }

    return repository.delete(id);
  }

  // Ramo do resume para campanha de video cujo campaign-trigger ainda nao
  // tinha disparado (trigger_fired_at nulo): tenta reagendar o mesmo job (se
  // ainda estiver "delayed" no Redis) em vez de recriar - preserva o job_id e
  // evita depender de removeOnFail/removeOnComplete para achar o antigo.
  async function resumeVideoTrigger(campaign, shiftedLogs, newWindowStart, newWindowEnd) {
    const precomputedSchedule = shiftedLogs
      .filter((log) => log.video_id && log.horario_envio_planejado)
      .map((log) => ({ group_id: log.group_id, video_id: log.video_id, scheduled_at: log.horario_envio_planejado }));

    let triggerJob = null;

    if (campaign.campaign_trigger_job_id) {
      try {
        triggerJob = await getCampaignTriggerQueueDependency().getJob(campaign.campaign_trigger_job_id);
      } catch (error) {
        triggerJob = null;
      }
    }

    if (triggerJob) {
      const state = await triggerJob.getState().catch(() => null);

      if (state === "delayed") {
        await triggerJob.changeDelay(Math.max(new Date(newWindowStart).getTime() - Date.now(), 0));
        await triggerJob.updateData({
          ...triggerJob.data,
          execution_at: newWindowStart,
          window_start: newWindowStart,
          window_end: newWindowEnd,
          precomputed_schedule: precomputedSchedule,
        });
        return;
      }
    }

    const newTriggerJob = await enqueueCampaignTrigger(
      {
        campaign_id: campaign.id,
        execution_at: newWindowStart,
        window_start: newWindowStart,
        window_end: newWindowEnd,
        jitter_delay_min_ms: campaign.jitter_delay_min_ms,
        jitter_delay_max_ms: campaign.jitter_delay_max_ms,
        precomputed_schedule: precomputedSchedule,
      },
      { removeOnComplete: false, removeOnFail: false }
    );

    if (newTriggerJob && newTriggerJob.id) {
      await repository.update(campaign.id, { campaign_trigger_job_id: newTriggerJob.id });
    }
  }

  // Ramo do resume para campanha de video cujo campaign-trigger ja tinha
  // disparado (ja existem jobs de dispatch por grupo). Tenta reagendar o job
  // que sobreviveu no Redis (changeDelay); so recria via
  // requeuePendingDispatchJobsForCampaign quando o job nao existe mais (ja
  // tinha disparado-e-virado-no-op durante a pausa).
  async function resumeVideoDispatchJobs(campaign, shiftedLogs) {
    const missingJobLogs = [];

    for (const log of shiftedLogs) {
      let job = null;

      if (log.dispatch_job_id) {
        try {
          job = await getDispatchQueueDependency().getJob(log.dispatch_job_id);
        } catch (error) {
          job = null;
        }
      }

      if (!job) {
        missingJobLogs.push(log);
        continue;
      }

      const state = await job.getState().catch(() => null);

      if (state === "delayed") {
        await job.changeDelay(Math.max(new Date(log.horario_envio_planejado).getTime() - Date.now(), 0));
      }
      // "active" ou outro estado: nao toca - ou ja esta em voo, ou o
      // claim/guarda de status decide o resultado quando ele rodar.
    }

    if (missingJobLogs.length) {
      await requeuePendingDispatchJobs(campaign.id, missingJobLogs);
    }
  }

  // Mesma logica do video, mas para campanha pontual (fila mensagens-dispatch,
  // sem fase de trigger separada - trigger_fired_at ja nasce preenchido).
  async function resumeTextMessages(campaign, shiftedLogs) {
    const missingJobLogs = [];

    for (const log of shiftedLogs) {
      let job = null;

      if (log.dispatch_job_id) {
        try {
          job = await getMensagensDispatchQueueDependency().getJob(log.dispatch_job_id);
        } catch (error) {
          job = null;
        }
      }

      if (!job) {
        missingJobLogs.push(log);
        continue;
      }

      const state = await job.getState().catch(() => null);

      if (state === "delayed") {
        await job.changeDelay(Math.max(new Date(log.horario_envio_planejado).getTime() - Date.now(), 0));
      }
    }

    if (missingJobLogs.length) {
      await mensagensServiceDependency.requeuePendingMessages(campaign, missingJobLogs);
    }
  }

  async function pauseCampaign(id) {
    if (!id) {
      throw new Error("Campaign id is required");
    }

    const campaign = await repository.findById(id);

    if (!campaign) {
      throw new Error("Campaign not found");
    }

    if (campaign.status !== "programado") {
      const error = new Error(
        "Campanha so pode ser pausada enquanto estiver programada para envio"
      );
      error.code = "CAMPAIGN_NOT_PAUSABLE";
      throw error;
    }

    const pendingLogs = await dispatchLogsRepositoryDependency.listPendingByCampaign(id);

    if (!pendingLogs.length) {
      const error = new Error("Nao ha envios pendentes para pausar nesta campanha");
      error.code = "CAMPAIGN_NOT_PAUSABLE";
      throw error;
    }

    return repository.update(id, {
      status: "pausado",
      paused_at: new Date().toISOString(),
    });
  }

  async function resumeCampaign(id) {
    if (!id) {
      throw new Error("Campaign id is required");
    }

    const campaign = await repository.findById(id);

    if (!campaign) {
      throw new Error("Campaign not found");
    }

    if (campaign.status !== "pausado") {
      const error = new Error("Campanha nao esta pausada");
      error.code = "CAMPAIGN_NOT_PAUSED";
      throw error;
    }

    const pausedAtMs = campaign.paused_at ? new Date(campaign.paused_at).getTime() : NaN;
    const pauseDurationMs = Number.isFinite(pausedAtMs) ? Math.max(Date.now() - pausedAtMs, 0) : 0;

    let newWindowStart = campaign.window_start;
    let newWindowEnd = campaign.window_end;

    if (campaign.window_start && campaign.window_end && pauseDurationMs > 0) {
      newWindowStart = new Date(new Date(campaign.window_start).getTime() + pauseDurationMs).toISOString();
      newWindowEnd = new Date(new Date(campaign.window_end).getTime() + pauseDurationMs).toISOString();

      const groupRows = await campaignGroupsRepositoryDependency.listGroups(id);

      await assertNoWindowConflict(
        groupRows.map((row) => row.group_id),
        { window_start: newWindowStart, window_end: newWindowEnd },
        { excludeId: id }
      );
    }

    const pendingLogs = await dispatchLogsRepositoryDependency.listPendingByCampaign(id);
    const shiftedLogs = [];

    for (const log of pendingLogs) {
      if (pauseDurationMs <= 0) {
        shiftedLogs.push(log);
        continue;
      }

      // Log sem horario planejado NAO pode receber `Date.now()` aqui: isso
      // gravava no banco um horario inventado para um envio que podia ser de
      // dias atras, destruindo de forma permanente a evidencia de atraso - e o
      // envio antigo passava a ser tratado como novo pelas travas. O fallback
      // correto e criado_em, o momento em que o envio foi de fato planejado.
      const anchorScheduledAt = resolveLogScheduledAt(log);

      if (!anchorScheduledAt) {
        console.warn &&
          console.warn(
            JSON.stringify({
              event: "campaigns.resume_skipped_log_sem_horario",
              campaign_id: id,
              log_id: log.id,
              group_id: log.group_id,
              note: "log sem horario_envio_planejado nem criado_em; nao pode ser reagendado sem inventar horario",
            })
          );
        continue;
      }

      const newPlanned = new Date(new Date(anchorScheduledAt).getTime() + pauseDurationMs).toISOString();
      const updated = await dispatchLogsRepositoryDependency.updatePlannedSchedule(log.id, newPlanned);
      shiftedLogs.push(updated || { ...log, horario_envio_planejado: newPlanned });
    }

    // tipo decide primeiro: campanha pontual nunca passa pelo campaign-trigger
    // (nem mesmo campanhas antigas, de antes de scheduleAdHoc gravar
    // trigger_fired_at na criacao, e que por isso tem esse campo nulo aqui).
    if (campaign.tipo === "pontual") {
      await resumeTextMessages(campaign, shiftedLogs);
    } else if (!campaign.trigger_fired_at) {
      await resumeVideoTrigger(campaign, shiftedLogs, newWindowStart, newWindowEnd);
    } else {
      await resumeVideoDispatchJobs(campaign, shiftedLogs);
    }

    return repository.update(id, {
      status: "programado",
      paused_at: null,
      total_paused_ms: (campaign.total_paused_ms || 0) + pauseDurationMs,
      window_start: newWindowStart,
      window_end: newWindowEnd,
    });
  }

  async function cancelCampaign(id) {
    if (!id) {
      throw new Error("Campaign id is required");
    }

    const campaign = await repository.findById(id);

    if (!campaign) {
      throw new Error("Campaign not found");
    }

    if (campaign.status === "cancelado") {
      return campaign;
    }

    if (campaign.status === "concluido") {
      const error = new Error("Campanha ja concluida nao pode ser cancelada");
      error.code = "CAMPAIGN_NOT_CANCELABLE";
      throw error;
    }

    await dispatchLogsRepositoryDependency.cancelPendingByCampaign(id);

    return repository.update(id, { status: "cancelado" });
  }

  async function getById(id) {
    if (!id) {
      throw new Error("Campaign id is required");
    }

    return repository.findById(id);
  }

  async function list() {
    return repository.findAll();
  }

  async function listActive() {
    return repository.listActive();
  }

  async function createForToday(payload = {}) {
    const referenceDate = payload.reference_date ? new Date(payload.reference_date) : new Date();
    const scheduleSettings = payload.schedule_settings || (await resolveScheduleSettings());
    const timezone = scheduleSettings.timezone;
    const dataEnvio = formatDateOnlyInTimezone(referenceDate, timezone);

    return repository.create({
      ativo: true,
      status: "programado",
      trilha: formatCampaignDayName(referenceDate, timezone),
      data_envio: dataEnvio,
      horario_envio: payload.horario_envio || payload.horarioEnvio || null,
      window_start: payload.window_start || null,
      window_end: payload.window_end || null,
    });
  }

  async function computeStatus(campaignId, campaignGroupRows, campaign) {
    // Pausado/cancelado sao estados persistidos e definitivos daqui: recalcular
    // por cima a partir dos logs/janela podia reclassificar uma campanha
    // pausada como "processada" (janela ja passou) ou uma cancelada com todos
    // os grupos ja resolvidos como "concluido", escondendo a acao do usuario.
    if (campaign && (campaign.status === "pausado" || campaign.status === "cancelado")) {
      return campaign.status;
    }

    const groupRows = campaignGroupRows || (await campaignGroupsRepositoryDependency.listGroups(campaignId));

    if (!groupRows.length) {
      return "programado";
    }

    const allTerminal = await campaignGroupsRepositoryDependency.isCampaignFullyTerminal(campaignId, {
      dispatchLogsRepository: dispatchLogsRepositoryDependency,
    });

    if (allTerminal) {
      return "concluido";
    }

    const windowEnd = campaign && campaign.window_end ? new Date(campaign.window_end) : null;

    if (windowEnd && !Number.isNaN(windowEnd.getTime()) && windowEnd.getTime() < Date.now()) {
      return "processada";
    }

    return "programado";
  }

  async function listWithSummary() {
    const campaigns = await repository.findAll();

    return Promise.all(
      campaigns.map(async (campaign) => {
        const groupRows = await campaignGroupsRepositoryDependency.listGroups(campaign.id);
        const status = await computeStatus(campaign.id, groupRows, campaign);

        return {
          ...campaign,
          status,
          grupos_total: groupRows.length,
        };
      })
    );
  }

  async function getGroupsDetail(campaignId) {
    if (!campaignId) {
      throw new Error("Campaign id is required");
    }

    const campaign = await repository.findById(campaignId);

    if (!campaign) {
      throw new Error("Campaign not found");
    }

    const [groupRows, logs] = await Promise.all([
      campaignGroupsRepositoryDependency.listGroups(campaignId),
      dispatchLogsRepositoryDependency.listByCampaign(campaignId),
    ]);

    return groupRows.map((row) => {
      const group = row.groups || row.group || {};
      const groupLogs = logs
        .filter((log) => log.group_id === row.group_id)
        .sort((left, right) => new Date(right.criado_em) - new Date(left.criado_em));
      const latestLog = groupLogs[0] || null;

      return {
        group_id: row.group_id,
        nome: group.nome || null,
        evolution_group_id: group.evolution_group_id || null,
        video_id: latestLog ? latestLog.video_id : null,
        status: latestLog ? latestLog.status : "pendente",
        criado_em: latestLog ? latestLog.criado_em : row.created_at,
      };
    });
  }

  return {
    cancelCampaign,
    confirmDispatch,
    create,
    createAndQueue,
    delete: remove,
    dispatchCampaign,
    pauseCampaign,
    remove,
    resumeCampaign,
    createForToday,
    getById,
    getGroupsDetail,
    list,
    listActive,
    listWithSummary,
    update,
  };
}

module.exports = createCampaignsService();
module.exports.createCampaignsService = createCampaignsService;
