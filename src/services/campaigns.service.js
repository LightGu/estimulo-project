const campaignsRepository = require("../repositories/campaigns.repository");
const campaignGroupsRepository = require("../repositories/campaign-groups.repository");
const groupsRepository = require("../repositories/groups.repository");
const organizationsRepository = require("../repositories/organizations.repository");
const { addCampaignTriggerJob } = require("../queues/campaign-trigger");

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
  const organizationRepository = dependencies.organizationRepository || organizationsRepository;
  const enqueueCampaignTrigger = dependencies.addCampaignTriggerJob || addCampaignTriggerJob;

  async function create(payload) {
    const organizationId = payload?.organization_id;
    const executionDate = normalizeScheduledDate(
      payload?.execution_at || payload?.executionAt || payload?.scheduled_at || payload?.scheduledAt || new Date()
    );
    const trilha = (payload?.trilha || payload?.trail || payload?.nome || "").trim();

    if (!trilha) {
      throw new Error("Campaign trail is required");
    }

    if (!organizationId) {
      throw new Error("Organization id is required");
    }

    const organization = await organizationRepository.findById(organizationId);

    if (!organization) {
      throw new Error("Organization not found");
    }

    return repository.create({
      organization_id: organizationId,
      ativo: payload?.ativo !== undefined ? Boolean(payload.ativo) : true,
      trilha,
      data_envio: payload?.data_envio || payload?.dataEnvio || null,
      horario_envio: payload?.horario_envio || payload?.horarioEnvio || null,
    });
  }

  async function createAndQueue(payload = {}) {
    const groupIds = normalizeGroupIds(payload);
    const trilha = (payload.trilha || payload.trail || payload.nome || "").trim();
    const organizationId = payload.organization_id;
    const executionDate = normalizeScheduledDate(
      payload.execution_at || payload.executionAt || payload.scheduled_at || payload.scheduledAt
    );

    if (!trilha) {
      throw new Error("Campaign trail is required");
    }

    if (!organizationId) {
      throw new Error("Organization id is required");
    }

    const organization = await organizationRepository.findById(organizationId);

    if (!organization) {
      throw new Error("Organization not found");
    }

    const groups = [];

    for (const groupId of groupIds) {
      const group = await groupsRepositoryDependency.findById(groupId);

      if (!group) {
        throw new Error("Group not found");
      }

      if (group.organization_id && group.organization_id !== organizationId) {
        throw new Error("Group does not belong to organization");
      }

      groups.push(group);
    }

    const scheduleOptions = resolveDispatchScheduleOptions(payload, executionDate);
    const campaign = await repository.create({
      organization_id: organizationId,
      ativo: true,
      trilha,
      data_envio: null,
      horario_envio: null,
    });
    const campaignGroups = [];

    for (const group of groups) {
      campaignGroups.push(await campaignGroupsRepositoryDependency.associateGroup(campaign.id, group.id));
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

  async function listByOrganization(organizationId) {
    if (!organizationId) {
      throw new Error("Organization id is required");
    }

    return repository.listByOrganization(organizationId);
  }

  return {
    create,
    createAndQueue,
    delete: remove,
    getById,
    list,
    listActive,
    listByOrganization,
    update,
  };
}

module.exports = createCampaignsService();
module.exports.createCampaignsService = createCampaignsService;
