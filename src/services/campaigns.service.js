const campaignsRepository = require("../repositories/campaigns.repository");
const campaignGroupsRepository = require("../repositories/campaign-groups.repository");
const groupsRepository = require("../repositories/groups.repository");
const dispatchLogsRepository = require("../repositories/dispatch-logs.repository");
const defaultCampaignVideoCaptionsService = require("./campaign-video-captions.service");
const {
  addCampaignTriggerJob,
  createPendingDispatchLogsForCampaign: defaultCreatePendingDispatchLogsForCampaign,
} = require("../queues/campaign-trigger");

const TERMINAL_LOG_STATUSES = ["enviado", "falhou"];
const TRIGGER_ENQUEUE_TIMEOUT_MS = Number(process.env.CAMPAIGN_TRIGGER_ENQUEUE_TIMEOUT_MS) || 5000;

function withTimeout(promise, timeoutMs, timeoutMessage) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)),
  ]);
}

function formatCampaignDayName(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: process.env.CAMPAIGN_TIMEZONE || process.env.TZ || "America/Bahia",
  })
    .formatToParts(date)
    .reduce((accumulator, part) => {
      accumulator[part.type] = part.value;
      return accumulator;
    }, {});

  return `Campanha do dia ${parts.day}/${parts.month}`;
}

function formatDateOnlyInTimezone(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: process.env.CAMPAIGN_TIMEZONE || process.env.TZ || "America/Bahia",
  })
    .formatToParts(date)
    .reduce((accumulator, part) => {
      accumulator[part.type] = part.value;
      return accumulator;
    }, {});

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizeScheduledDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error("Execution date is invalid");
  }

  return date;
}

function formatDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function formatTimeOnly(date) {
  return date.toISOString().slice(11, 19);
}

function normalizeNumber(value, defaultValue) {
  const number = Number(value ?? defaultValue);

  return Number.isFinite(number) ? Math.trunc(number) : defaultValue;
}

function resolveDispatchScheduleOptions(payload = {}, executionDate = new Date()) {
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
  const jitterMin = payload.jitter_delay_min_ms ?? payload.jitterDelayMinMs ?? process.env.CAMPAIGN_DISPATCH_JITTER_MIN_MS;
  const jitterMax = payload.jitter_delay_max_ms ?? payload.jitterDelayMaxMs ?? process.env.CAMPAIGN_DISPATCH_JITTER_MAX_MS;
  const minMs = normalizeNumber(jitterMin, 60000);
  const maxMs = normalizeNumber(jitterMax, 300000);

  return {
    window_start: windowStart,
    window_end: windowEnd,
    jitter_delay_min_ms: minMs,
    jitter_delay_max_ms: Math.max(maxMs, minMs),
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
  const enqueueCampaignTrigger = dependencies.addCampaignTriggerJob || addCampaignTriggerJob;
  const createPendingDispatchLogs = (campaignId, scheduleParams = {}) =>
    (dependencies.createPendingDispatchLogsForCampaign || defaultCreatePendingDispatchLogsForCampaign)(campaignId, {
      campaignGroups: campaignGroupsRepositoryDependency,
      campaigns: repository,
      dispatchLogs: dispatchLogsRepositoryDependency,
      videoCatalogRepository: dependencies.videoCatalogRepository,
      groupVideoProgressRepository: dependencies.groupVideoProgressRepository,
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

  async function createAndQueue(payload = {}) {
    const groupIds = normalizeGroupIds(payload);
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

    const scheduleOptions = resolveDispatchScheduleOptions(payload, executionDate);
    const campaign = await findOrCreateForToday({ reference_date: executionDate });

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
      },
      {
        removeOnComplete: false,
        removeOnFail: false,
      }
    );

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

  async function dispatchCampaign(payload = {}) {
    const result = await createAndQueue({ ...payload, defer_dispatch: true });

    campaignVideoCaptionsServiceDependency
      .generateCaptionsForCampaign(result.campaign.id)
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

    const progress = await campaignVideoCaptionsServiceDependency.getCaptionProgress(campaignId);

    if (progress.pendente > 0) {
      const error = new Error("Existem legendas pendentes para esta campanha");
      error.code = "CAPTIONS_PENDING";
      throw error;
    }

    const executionDate = normalizeScheduledDate(
      payload.execution_at || payload.executionAt || payload.scheduled_at || payload.scheduledAt
    );
    const scheduleOptions = resolveDispatchScheduleOptions(payload, executionDate);

    const pendingLogs = await createPendingDispatchLogs(campaign.id, {
      execution_at: executionDate.toISOString(),
      window_start: scheduleOptions.window_start,
      window_end: scheduleOptions.window_end,
      jitter_delay_min_ms: scheduleOptions.jitter_delay_min_ms,
      jitter_delay_max_ms: scheduleOptions.jitter_delay_max_ms,
    });
    const updatedCampaign = await repository.update(campaignId, { status: "programado" });

    let triggerJob = null;
    let triggerJobError = null;

    try {
      triggerJob = await withTimeout(
        enqueueCampaignTrigger(
          {
            campaign_id: campaign.id,
            execution_at: executionDate.toISOString(),
            time_window: payload.time_window || payload.timeWindow,
            dispatch_jitter: payload.dispatch_jitter || payload.dispatchJitter,
            window_start: scheduleOptions.window_start,
            window_end: scheduleOptions.window_end,
            jitter_delay_min_ms: scheduleOptions.jitter_delay_min_ms,
            jitter_delay_max_ms: scheduleOptions.jitter_delay_max_ms,
          },
          {
            removeOnComplete: false,
            removeOnFail: false,
          }
        ),
        TRIGGER_ENQUEUE_TIMEOUT_MS,
        "Timeout ao enfileirar campaign-trigger"
      );
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

    return repository.delete(id);
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

  async function findOrCreateForToday(payload = {}) {
    const referenceDate = payload.reference_date ? new Date(payload.reference_date) : new Date();
    const dataEnvio = formatDateOnlyInTimezone(referenceDate);

    const existing = await repository.findByData(dataEnvio);

    if (existing) {
      return existing;
    }

    return repository.create({
      ativo: true,
      status: "programado",
      trilha: formatCampaignDayName(referenceDate),
      data_envio: dataEnvio,
      horario_envio: payload.horario_envio || payload.horarioEnvio || null,
    });
  }

  async function computeStatus(campaignId, campaignGroupRows) {
    const groupRows = campaignGroupRows || (await campaignGroupsRepositoryDependency.listGroups(campaignId));

    if (!groupRows.length) {
      return "programado";
    }

    const logs = await dispatchLogsRepositoryDependency.listByCampaign(campaignId);
    const latestStatusByGroup = new Map();

    logs.forEach((log) => {
      if (!latestStatusByGroup.has(log.group_id)) {
        latestStatusByGroup.set(log.group_id, log.status);
      }
    });

    const allTerminal = groupRows.every((row) => {
      const status = latestStatusByGroup.get(row.group_id);
      return status && TERMINAL_LOG_STATUSES.includes(status);
    });

    return allTerminal ? "concluido" : "programado";
  }

  async function listWithSummary() {
    const campaigns = await repository.findAll();

    return Promise.all(
      campaigns.map(async (campaign) => {
        const groupRows = await campaignGroupsRepositoryDependency.listGroups(campaign.id);
        const status = await computeStatus(campaign.id, groupRows);

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
    confirmDispatch,
    create,
    createAndQueue,
    delete: remove,
    dispatchCampaign,
    findOrCreateForToday,
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
