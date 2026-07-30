const { createQueue, createQueueEvents, createWorker } = require("./bullmq");
const { addDispatchJob, addJitteredDispatchJobs } = require("./dispatch");
const { buildJitteredDispatchSchedule, resolveInstanceForOrder } = require("./dispatch-jitter");
const campaignGroupsRepository = require("../repositories/campaign-groups.repository");
const campaignVideoCaptionsRepository = require("../repositories/campaign-video-captions.repository");
const campaignsRepository = require("../repositories/campaigns.repository");
const dispatchLogsRepository = require("../repositories/dispatch-logs.repository");
const groupVideoProgressRepository = require("../repositories/group-video-progress.repository");
const trilhasRepository = require("../repositories/trilhas.repository");
const videoCatalogRepository = require("../repositories/video-catalog.repository");
const defaultWhatsappInstancesRepository = require("../repositories/whatsapp-instances.repository");
const defaultWhatsappInstancesService = require("../services/whatsapp-instances.service");
const defaultNotificationsService = require("../services/notifications.service");
const defaultInAppNotificationsService = require("../services/in-app-notifications.service");
const defaultSettingsService = require("../services/settings.service");
const {
  resolveGroupTrailId,
  resolveGroupsVideoFlow,
  selectNextApprovedUnsentVideo,
} = require("../services/group-video-flow");
const { queueNames } = require("./names");

const CAMPAIGN_TRIGGER_JOB_NAME = "trigger-campaign";
const CAMPAIGN_TRIGGER_INITIAL_STATUS = "pending";
const CAMPAIGN_TRIGGER_ACTIVE_STATUS = "active";
const CAMPAIGN_TRIGGER_INACTIVE_STATUS = "inactive";
const CAMPAIGN_TRIGGER_TYPE_RECURRING = "recurring";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_CAMPAIGN_TIMEZONE = "America/Bahia";

let campaignTriggerQueueInstance;

function getCampaignTriggerQueue() {
  if (!campaignTriggerQueueInstance) {
    // attempts:1 evita que uma falha apos notifyCampaignStarted (ex.: erro
    // transitorio no Redis/repositorio) refaca o job do zero e reenvie a
    // notificacao de "campanha iniciada" para o WhatsApp.
    campaignTriggerQueueInstance = createQueue(queueNames.campaignTrigger, {
      defaultJobOptions: {
        attempts: 1,
      },
    });
  }

  return campaignTriggerQueueInstance;
}

function normalizeExecutionDate(executionAt = new Date()) {
  const date = executionAt instanceof Date ? executionAt : new Date(executionAt);

  if (Number.isNaN(date.getTime())) {
    throw new Error("execution_at deve ser uma data valida");
  }

  return date;
}

function getCampaignTimezone() {
  return process.env.CAMPAIGN_TIMEZONE || process.env.TZ || DEFAULT_CAMPAIGN_TIMEZONE;
}

function formatScheduledDateTime(value, timeZone = getCampaignTimezone()) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error("scheduled_at deve ser uma data valida");
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric",
  })
    .formatToParts(date)
    .reduce((accumulator, part) => {
      accumulator[part.type] = part.value;
      return accumulator;
    }, {});

  return {
    data_envio: `${parts.year}-${parts.month}-${parts.day}`,
    horario_envio: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

function buildCampaignTriggerJobData(params) {
  if (!params || !params.campaign_id) {
    throw new Error("campaign_id e obrigatorio para enfileirar campaign-trigger");
  }

  const executionDate = normalizeExecutionDate(params.execution_at || params.executionAt);
  const timeWindow = normalizeTimeWindow(params);
  const dispatchJitter = normalizeDispatchJitter(params);
  const timezone = params.timezone || params.tz;

  return {
    campaign_id: params.campaign_id,
    execution_at: executionDate.toISOString(),
    time_window: timeWindow,
    dispatch_jitter: dispatchJitter,
    precomputed_schedule: normalizePrecomputedSchedule(params),
    timezone: timezone || undefined,
    status: params.status || CAMPAIGN_TRIGGER_INITIAL_STATUS,
  };
}

function assertCampaignId(params) {
  if (!params || !params.campaign_id) {
    throw new Error("campaign_id e obrigatorio para agendar campaign-trigger");
  }
}

function buildCampaignScheduleKey(campaignId) {
  return `campaign-trigger-${encodeURIComponent(String(campaignId))}`;
}

function normalizeBooleanStatus(params = {}) {
  if (params.active !== undefined) {
    if (typeof params.active === "boolean") {
      return params.active;
    }

    const activeValue = String(params.active).toLowerCase();

    return !["false", "0", "inactive", "inativo", "disabled", "paused"].includes(activeValue);
  }

  const rawStatus = String(params.status || CAMPAIGN_TRIGGER_ACTIVE_STATUS).toLowerCase();
  const inactiveStatuses = new Set([
    "inactive",
    "inativo",
    "inativa",
    "disabled",
    "paused",
    "cancelled",
    "canceled",
  ]);

  return !inactiveStatuses.has(rawStatus);
}

function normalizeDateField(value, fieldName) {
  if (!value) {
    return undefined;
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} deve ser uma data valida`);
  }

  return date;
}

function normalizeTimeWindow(params = {}) {
  const timeWindow = params.time_window || params.timeWindow || {};
  const start = params.window_start || params.windowStart || timeWindow.start || timeWindow.start_at;
  const end = params.window_end || params.windowEnd || timeWindow.end || timeWindow.end_at;

  if (!start && !end) {
    return undefined;
  }

  if (!start || !end) {
    throw new Error("window_start e window_end devem ser informados juntos");
  }

  return {
    start,
    end,
    timezone: params.timezone || timeWindow.timezone || params.tz,
  };
}

function normalizeDispatchJitter(params = {}) {
  const jitter = params.dispatch_jitter || params.dispatchJitter || params.jitter || {};
  const minDelay =
    params.jitter_delay_min_ms ??
    params.jitterDelayMinMs ??
    params.min_delay_ms ??
    params.minDelayMs ??
    jitter.min_ms ??
    jitter.minDelayMs;
  const maxDelay =
    params.jitter_delay_max_ms ??
    params.jitterDelayMaxMs ??
    params.max_delay_ms ??
    params.maxDelayMs ??
    jitter.max_ms ??
    jitter.maxDelayMs;

  if (minDelay === undefined && maxDelay === undefined) {
    return undefined;
  }

  if (minDelay === undefined || maxDelay === undefined) {
    throw new Error("jitter_delay_min_ms e jitter_delay_max_ms devem ser informados juntos");
  }

  const minMs = Math.trunc(Number(minDelay));
  const maxMs = Math.trunc(Number(maxDelay));

  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) {
    throw new Error("jitter_delay_min_ms e jitter_delay_max_ms devem ser numeros validos");
  }

  if (minMs < 0 || maxMs < 0) {
    throw new Error("jitter_delay_min_ms e jitter_delay_max_ms devem ser maiores ou iguais a zero");
  }

  if (maxMs < minMs) {
    throw new Error("jitter_delay_max_ms deve ser maior ou igual a jitter_delay_min_ms");
  }

  return {
    min_ms: minMs,
    max_ms: maxMs,
  };
}

// Horarios ja sorteados na confirmacao do envio (campaigns.service.confirmDispatch).
// Quando presentes, o worker reaproveita esse sorteio em vez de fazer um novo:
// e o mesmo horario que ja foi gravado em dispatch_logs e mostrado no relatorio.
function normalizePrecomputedSchedule(params = {}) {
  const schedule = params.precomputed_schedule || params.precomputedSchedule;

  if (!Array.isArray(schedule)) {
    return undefined;
  }

  const normalized = schedule
    .filter((item) => item && item.group_id && item.scheduled_at)
    .map((item) => ({
      group_id: item.group_id,
      video_id: item.video_id,
      scheduled_at: item.scheduled_at,
      dispatch_order: item.dispatch_order,
    }));

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeRepeatOptions(params = {}) {
  const recurrenceRule = params.recurrence_rule || params.recurrenceRule || params.repeat || {};
  const pattern =
    params.cron_expression ||
    params.cronExpression ||
    recurrenceRule.cron_expression ||
    recurrenceRule.cronExpression ||
    recurrenceRule.pattern;
  const every = params.every || recurrenceRule.every;

  if (pattern && every) {
    throw new Error("Informe cron_expression ou every, nao ambos");
  }

  if (!pattern && !every) {
    throw new Error("cron_expression, recurrence_rule.pattern ou recurrence_rule.every e obrigatorio");
  }

  const repeatOptions = {
    key: buildCampaignScheduleKey(params.campaign_id),
  };

  if (pattern) {
    repeatOptions.pattern = pattern;
  }

  if (every) {
    repeatOptions.every = Number(every);

    if (!Number.isFinite(repeatOptions.every) || repeatOptions.every <= 0) {
      throw new Error("recurrence_rule.every deve ser um numero positivo em milissegundos");
    }
  }

  const startDate = normalizeDateField(params.start_date || params.startDate || recurrenceRule.startDate, "start_date");
  const endDate = normalizeDateField(params.end_date || params.endDate || recurrenceRule.endDate, "end_date");

  if (startDate) {
    repeatOptions.startDate = startDate;
  }

  if (endDate) {
    repeatOptions.endDate = endDate;
  }

  if (params.timezone || params.tz || recurrenceRule.tz) {
    repeatOptions.tz = params.timezone || params.tz || recurrenceRule.tz;
  }

  if (params.limit || recurrenceRule.limit) {
    repeatOptions.limit = Number(params.limit || recurrenceRule.limit);

    if (!Number.isInteger(repeatOptions.limit) || repeatOptions.limit <= 0) {
      throw new Error("recurrence_rule.limit deve ser um inteiro positivo");
    }
  }

  if (params.immediately !== undefined || recurrenceRule.immediately !== undefined) {
    repeatOptions.immediately = Boolean(params.immediately ?? recurrenceRule.immediately);
  }

  return repeatOptions;
}

function buildCampaignScheduleJobData(params, repeatOptions) {
  const active = normalizeBooleanStatus(params);
  const timeWindow = normalizeTimeWindow(params);
  const dispatchJitter = normalizeDispatchJitter(params);
  const now = new Date().toISOString();

  return {
    campaign_id: params.campaign_id,
    schedule_key: repeatOptions.key,
    trigger_type: CAMPAIGN_TRIGGER_TYPE_RECURRING,
    recurrence: {
      pattern: repeatOptions.pattern,
      every: repeatOptions.every,
      start_date: repeatOptions.startDate ? repeatOptions.startDate.toISOString() : undefined,
      end_date: repeatOptions.endDate ? repeatOptions.endDate.toISOString() : undefined,
      timezone: repeatOptions.tz,
      limit: repeatOptions.limit,
    },
    time_window: timeWindow,
    dispatch_jitter: dispatchJitter,
    active,
    status: active ? CAMPAIGN_TRIGGER_ACTIVE_STATUS : CAMPAIGN_TRIGGER_INACTIVE_STATUS,
    dispatch_queue: queueNames.dispatch,
    created_at: now,
    updated_at: now,
  };
}

function buildCampaignTriggerJobOptions(jobData, options = {}) {
  const executionTime = new Date(jobData.execution_at).getTime();
  const delay = Math.max(executionTime - Date.now(), 0);

  return {
    ...options,
    delay: options.delay ?? delay,
  };
}

async function addCampaignTriggerJob(params, options = {}) {
  const jobData = buildCampaignTriggerJobData(params);
  const jobOptions = buildCampaignTriggerJobOptions(jobData, options);

  return getCampaignTriggerQueue().add(CAMPAIGN_TRIGGER_JOB_NAME, jobData, jobOptions);
}

async function removeCampaignSchedule(params) {
  const campaignId = typeof params === "string" ? params : params && params.campaign_id;

  if (!campaignId) {
    throw new Error("campaign_id e obrigatorio para remover agendamento de campanha");
  }

  const scheduleKey = buildCampaignScheduleKey(campaignId);
  const removed = await getCampaignTriggerQueue().removeRepeatableByKey(scheduleKey);

  return {
    campaign_id: campaignId,
    schedule_key: scheduleKey,
    removed,
  };
}

async function disableCampaignSchedule(params) {
  return removeCampaignSchedule(params);
}

async function scheduleCampaign(params, options = {}) {
  assertCampaignId(params);

  const active = normalizeBooleanStatus(params);

  if (!active) {
    return disableCampaignSchedule(params);
  }

  const repeatOptions = normalizeRepeatOptions(params);
  const jobData = buildCampaignScheduleJobData(params, repeatOptions);
  const { repeat: _ignoredRepeatOptions, ...jobOptionOverrides } = options;
  const jobOptions = {
    ...jobOptionOverrides,
    repeat: repeatOptions,
  };

  return getCampaignTriggerQueue().add(CAMPAIGN_TRIGGER_JOB_NAME, jobData, jobOptions);
}

function extractCampaignGroup(row = {}) {
  return row.groups || row.group || row;
}

function isVideoEnabledGroup(group = {}) {
  return group.envia_video === true;
}

async function applyCampaignTrailFallback(group, campaign, dependencies = {}) {
  if (resolveGroupTrailId(group)) {
    return group;
  }

  const campaignTrail = campaign && (campaign.trilha || campaign.nome);

  if (!campaignTrail || group.trilha_override || group.trilhaOverride) {
    return group;
  }

  const trilhasRepositoryDependency = dependencies.trilhasRepository || trilhasRepository;

  // campaigns.trilha/nome continuam texto livre (fora do escopo desta migracao) -- o
  // fallback so consegue resolver trilha_id fazendo um lookup por nome, que pode ser
  // ambiguo se o mesmo nome de trilha existir em mais de um macrotema; nesse caso
  // findByTrilhaName ja escolhe um resultado deterministico (o mais antigo).
  const trilha = typeof trilhasRepositoryDependency.findByTrilhaName === "function"
    ? await trilhasRepositoryDependency.findByTrilhaName(campaignTrail)
    : null;

  if (trilha) {
    return { ...group, trilha_id: trilha.id };
  }

  return {
    ...group,
    trilha_override: campaignTrail,
  };
}

async function resolveDispatchRules(settingsService = defaultSettingsService) {
  try {
    return await settingsService.getDispatchRulesSettings();
  } catch (error) {
    return {};
  }
}

function buildCampaignVideoFlowRepository(dependencies = {}) {
  const videosRepository = dependencies.videoCatalogRepository || videoCatalogRepository;
  const progressRepository = dependencies.groupVideoProgressRepository || groupVideoProgressRepository;
  const trilhasRepositoryDependency = dependencies.trilhasRepository || trilhasRepository;

  return {
    async findNextApprovedUnsentVideoForGroup(group, options = {}) {
      const trailId = resolveGroupTrailId(group);

      if (!trailId) {
        return undefined;
      }

      const [delivered, links] = await Promise.all([
        typeof progressRepository.listDelivered === "function" ? progressRepository.listDelivered(group.id) : [],
        trilhasRepositoryDependency.listVideoLinksByTrilha(trailId),
      ]);

      const videos = links.length
        ? await (async () => {
            const approved = typeof videosRepository.listApproved === "function" ? await videosRepository.listApproved() : [];
            const approvedById = new Map(approved.map((video) => [video.id, video]));

            return links
              .filter((link) => approvedById.has(link.video_id))
              .map((link) => ({ ...approvedById.get(link.video_id), ordem: link.ordem }));
          })()
        : [];
      const sentVideoIds = delivered.map((item) => item.video_id || item.videoId).filter(Boolean);

      return selectNextApprovedUnsentVideo({
        group,
        sentVideoIds,
        videos,
        neverRepeatVideo: options.neverRepeatVideo,
      });
    },
  };
}

// Prioriza a legenda ja gerada/revisada na Etapa 2 (tela envio-automatizado.html,
// tabela campaign_video_captions); so mantem o texto manual (group.legenda, ja
// preenchido pelo caminho legado) quando nao houver legenda gerada para o par
// group_id+video_id.
async function applyGeneratedCaptions(campaignId, dispatchGroups, dependencies = {}) {
  if (!dispatchGroups.length) {
    return dispatchGroups;
  }

  const campaignVideoCaptions = dependencies.campaignVideoCaptionsRepository || campaignVideoCaptionsRepository;

  if (typeof campaignVideoCaptions.listByCampaign !== "function") {
    return dispatchGroups;
  }

  const captionRows = await campaignVideoCaptions.listByCampaign(campaignId);
  const generatedByKey = new Map(
    captionRows
      .filter((row) => row.status === "gerado" && row.caption_text)
      .map((row) => [`${row.group_id}::${row.video_id}`, row])
  );

  return dispatchGroups.map((group) => {
    const generated = generatedByKey.get(`${group.progress_group_id}::${group.video_id}`);

    if (!generated) {
      return group;
    }

    return {
      ...group,
      legenda: generated.caption_text,
      caption_id: generated.caption_id || undefined,
      caption_generated: true,
    };
  });
}

function buildDispatchParams(jobData, dispatchGroups, options = {}) {
  return {
    campaign_id: jobData.campaign_id,
    execution_at: jobData.execution_at || jobData.created_at || new Date(),
    groups: dispatchGroups,
    time_window: jobData.time_window,
    dispatch_jitter: jobData.dispatch_jitter,
    window_start: jobData.time_window && jobData.time_window.start,
    window_end: jobData.time_window && jobData.time_window.end,
    jitter_delay_min_ms: jobData.dispatch_jitter && jobData.dispatch_jitter.min_ms,
    jitter_delay_max_ms: jobData.dispatch_jitter && jobData.dispatch_jitter.max_ms,
    whatsapp_instances: options.whatsappInstances,
    rotation_group_count: options.rotationGroupCount,
  };
}

// Carrega, uma vez por execucao do trigger, as instancias ativas (ordenadas por
// prioridade) e o N global de rodizio - usados tanto no caminho com jitter
// (dispatch-jitter.js resolve por grupo) quanto no caminho sem jitter abaixo.
async function resolveActiveInstancesAndRotation(dependencies = {}) {
  const instancesRepository = dependencies.whatsappInstancesRepository || defaultWhatsappInstancesRepository;
  const instancesService = dependencies.whatsappInstancesService || defaultWhatsappInstancesService;

  const [whatsappInstances, rotationSettings] = await Promise.all([
    instancesRepository.listActive(),
    instancesService.getRotationSettings(),
  ]);

  return {
    whatsappInstances,
    rotationGroupCount: rotationSettings.whatsapp_rotation_group_count,
  };
}

function resolvePrecomputedScheduleByGroup(jobData = {}) {
  const schedule = Array.isArray(jobData.precomputed_schedule) ? jobData.precomputed_schedule : [];

  return new Map(
    schedule
      .filter((item) => item && item.group_id && item.scheduled_at)
      .map((item) => [String(item.group_id), item])
  );
}

function shouldUseJitteredDispatch(jobData = {}) {
  return Boolean(
    jobData.time_window &&
      jobData.time_window.start &&
      jobData.time_window.end &&
      jobData.dispatch_jitter &&
      jobData.dispatch_jitter.min_ms !== undefined &&
      jobData.dispatch_jitter.max_ms !== undefined
  );
}

// Remove da lista os grupos que nao estao vinculados a todas as instancias
// WhatsApp ativas (quando ha 2+ numeros cadastrados - com 0 ou 1 numero e um
// no-op). Nao aborta a campanha inteira: cada grupo sem cobertura completa e
// apenas pulado nesta rodada, com um evento de log para rastreabilidade.
async function filterGroupsMissingInstanceCoverage(dispatchGroups, dependencies = {}, logger = console) {
  if (!dispatchGroups.length) {
    return dispatchGroups;
  }

  const instancesService = dependencies.whatsappInstancesService || defaultWhatsappInstancesService;
  const groupIds = dispatchGroups.map((group) => group.progress_group_id).filter(Boolean);
  const { ineligible } = await instancesService.filterDispatchableGroups(groupIds);

  if (!ineligible.length) {
    return dispatchGroups;
  }

  const ineligibleSet = new Set(ineligible);

  ineligible.forEach((groupId) => {
    logger.warn &&
      logger.warn(
        JSON.stringify({
          event: "dispatch.skipped_missing_instance_coverage",
          group_id: groupId,
        })
      );
  });

  return dispatchGroups.filter((group) => !ineligibleSet.has(group.progress_group_id));
}

async function enqueueResolvedDispatchJobs(jobData, dispatchGroups, dependencies = {}) {
  const addSingleDispatchJob = dependencies.addDispatchJob || addDispatchJob;
  const addManyJitteredDispatchJobs = dependencies.addJitteredDispatchJobs || addJitteredDispatchJobs;

  if (dispatchGroups.length === 0) {
    return [];
  }

  const { whatsappInstances, rotationGroupCount } = await resolveActiveInstancesAndRotation(dependencies);
  const precomputedByGroup = resolvePrecomputedScheduleByGroup(jobData);
  // So reaproveita o sorteio da confirmacao se ele cobrir todos os grupos desta
  // execucao; se a lista mudou no meio do caminho (grupo pausado, video novo),
  // cai no caminho normal e sorteia de novo para nao deixar grupo sem horario.
  const hasFullPrecomputedSchedule =
    precomputedByGroup.size > 0 &&
    dispatchGroups.every((group) => precomputedByGroup.has(String(group.progress_group_id)));

  if (!hasFullPrecomputedSchedule && shouldUseJitteredDispatch(jobData)) {
    return addManyJitteredDispatchJobs(
      buildDispatchParams(jobData, dispatchGroups, { whatsappInstances, rotationGroupCount })
    );
  }

  const scheduledAt = jobData.execution_at || new Date().toISOString();
  const jobs = [];

  for (const [index, group] of dispatchGroups.entries()) {
    const precomputed = precomputedByGroup.get(String(group.progress_group_id));
    const dispatchOrder = (precomputed && precomputed.dispatch_order) || group.dispatch_order || group.order || index + 1;

    jobs.push(
      await addSingleDispatchJob({
        ...group,
        campaign_id: group.campaign_id || jobData.campaign_id,
        scheduled_at: (precomputed && precomputed.scheduled_at) || group.scheduled_at || scheduledAt,
        dispatch_order: dispatchOrder,
        whatsapp_instance_id: resolveInstanceForOrder(dispatchOrder, whatsappInstances, rotationGroupCount),
      })
    );
  }

  return jobs;
}

function extractScheduledAtFromDispatchJob(job) {
  return job && job.data && job.data.scheduled_at;
}

function extractDispatchLogPayloadFromJob(job) {
  const data = (job && job.data) || {};
  const groupId = data.progress_group_id || data.progressGroupId || data.group_db_id;

  if (!data.campaign_id || !groupId || !data.video_id) {
    return null;
  }

  return {
    campaign_id: data.campaign_id,
    group_id: groupId,
    video_id: data.video_id,
    status: "pendente",
    mensagem_erro: null,
    horario_envio_planejado: data.scheduled_at || null,
  };
}

function hasExistingDispatchLog(existingLogs, payload) {
  return (existingLogs || []).some((entry) => (
    entry.campaign_id === payload.campaign_id &&
    entry.group_id === payload.group_id &&
    entry.video_id === payload.video_id
  ));
}

async function ensurePendingDispatchLogs(dispatchLogs, campaignId, dispatchJobs, logger = console) {
  if (!dispatchLogs || typeof dispatchLogs.createLog !== "function" || !Array.isArray(dispatchJobs)) {
    return 0;
  }

  const payloads = dispatchJobs
    .map(extractDispatchLogPayloadFromJob)
    .filter(Boolean);

  if (payloads.length === 0) {
    return 0;
  }

  const existingLogs = typeof dispatchLogs.listByCampaign === "function"
    ? await dispatchLogs.listByCampaign(campaignId)
    : [];
  let created = 0;

  for (const payload of payloads) {
    const existingLog = existingLogs.find((entry) => (
      entry.campaign_id === payload.campaign_id &&
      entry.group_id === payload.group_id &&
      entry.video_id === payload.video_id
    ));

    if (existingLog) {
      // Os logs podem ter sido criados antes de o worker montar os jobs. O
      // horario do job e a fonte de verdade (o jitter e calculado nele), entao
      // completa ou sincroniza o registro em vez de manter o relatorio com "-"
      // ou com uma previa diferente do horario efetivo.
      if (
        payload.horario_envio_planejado &&
        existingLog.id &&
        existingLog.horario_envio_planejado !== payload.horario_envio_planejado &&
        typeof dispatchLogs.updatePlannedSchedule === "function"
      ) {
        const updatedLog = await dispatchLogs.updatePlannedSchedule(
          existingLog.id,
          payload.horario_envio_planejado
        );
        Object.assign(existingLog, updatedLog || { horario_envio_planejado: payload.horario_envio_planejado });

        logger.info &&
          logger.info(
            JSON.stringify({
              event: "dispatch_log.planned_schedule_synchronized",
              campaign_id: payload.campaign_id,
              group_id: payload.group_id,
              video_id: payload.video_id,
              log_id: existingLog.id,
              horario_envio_planejado: payload.horario_envio_planejado,
            })
          );
      }
      continue;
    }

    const log = await dispatchLogs.createLog(payload);
    existingLogs.push(log || payload);
    created += 1;

    logger.info &&
      logger.info(
        JSON.stringify({
          event: "dispatch_log.pending_created",
          campaign_id: payload.campaign_id,
          group_id: payload.group_id,
          video_id: payload.video_id,
          log_id: log && log.id,
        })
      );
  }

  return created;
}

async function updateCampaignScheduledDispatch(campaigns, campaignId, dispatchJobs, timezone) {
  if (!campaigns || typeof campaigns.update !== "function" || !campaignId || !Array.isArray(dispatchJobs)) {
    return null;
  }

  const scheduledTimes = dispatchJobs
    .map(extractScheduledAtFromDispatchJob)
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((left, right) => left.getTime() - right.getTime());

  if (scheduledTimes.length === 0) {
    return null;
  }

  return campaigns.update(campaignId, {
    ativo: true,
    ...formatScheduledDateTime(scheduledTimes[0], timezone || getCampaignTimezone()),
  });
}

// Unico ponto onde os horarios aleatorios de cada grupo sao sorteados: roda na
// confirmacao do envio (campaigns.service.confirmDispatch) e o resultado vai
// tanto para dispatch_logs quanto para o job de campaign-trigger. Um erro aqui
// (janela curta demais para os grupos) precisa chegar na tela nesse momento --
// engolir a falha era o que deixava o relatorio sem horario planejado e so
// derrubava o disparo depois, la na fila.
function buildPlannedDispatchSchedule(dispatchGroups, scheduleParams, logger = console) {
  if (!dispatchGroups.length || !scheduleParams || !scheduleParams.window_start || !scheduleParams.window_end) {
    return [];
  }

  try {
    return buildJitteredDispatchSchedule({
      ...scheduleParams,
      groups: dispatchGroups.map((group) => ({
        group_id: group.progress_group_id,
        video_id: group.video_id,
        envia_video: true,
      })),
    });
  } catch (error) {
    logger.error &&
      logger.error(
        JSON.stringify({
          event: "dispatch_log.planned_schedule_failed",
          error_message: error.message,
        })
      );

    throw error;
  }
}

async function createPendingDispatchLogsForCampaign(campaignId, options = {}) {
  const {
    campaignGroups = campaignGroupsRepository,
    campaigns = campaignsRepository,
    dispatchLogs = dispatchLogsRepository,
    trilhasRepository: trilhasRepositoryOption = trilhasRepository,
    videoFlowRepository = buildCampaignVideoFlowRepository(options),
    settingsService: settingsServiceOption = defaultSettingsService,
    notificationsService: notificationsServiceOption = defaultNotificationsService,
    inAppNotificationsService: inAppNotificationsServiceOption = defaultInAppNotificationsService,
    logger = console,
  } = options;

  if (!campaignId) {
    throw new Error("campaign_id e obrigatorio para criar logs de disparo");
  }

  const campaign = campaigns && typeof campaigns.findById === "function"
    ? await campaigns.findById(campaignId)
    : null;
  const campaignGroupRows = await campaignGroups.listGroups(campaignId);
  const groupsWithFallback = await Promise.all(
    campaignGroupRows
      .map(extractCampaignGroup)
      .map((group) => applyCampaignTrailFallback(group, campaign, { trilhasRepository: trilhasRepositoryOption }))
  );
  const groups = groupsWithFallback.filter(isVideoEnabledGroup);
  const dispatchRules = await resolveDispatchRules(settingsServiceOption);
  const flow = await resolveGroupsVideoFlow({
    campaign_id: campaignId,
    groups,
    repository: videoFlowRepository,
    dispatchRules,
    notificationsService: notificationsServiceOption,
    inAppNotificationsService: inAppNotificationsServiceOption,
    logger,
  });
  const dispatchableGroups = await filterGroupsMissingInstanceCoverage(flow.dispatchGroups, options, logger);
  const plannedSchedule = buildPlannedDispatchSchedule(
    dispatchableGroups,
    {
      execution_at: options.execution_at,
      window_start: options.window_start,
      window_end: options.window_end,
      jitter_delay_min_ms: options.jitter_delay_min_ms,
      jitter_delay_max_ms: options.jitter_delay_max_ms,
    },
    logger
  );
  const plannedScheduleByKey = new Map(
    plannedSchedule.map((item) => [`${item.group_id}::${item.video_id}`, item.scheduled_at])
  );
  const logPayloads = dispatchableGroups
    .map((group) => ({
      campaign_id: campaignId,
      group_id: group.progress_group_id,
      video_id: group.video_id,
      status: "pendente",
      mensagem_erro: null,
      horario_envio_planejado: plannedScheduleByKey.get(`${group.progress_group_id}::${group.video_id}`) || null,
    }))
    .filter((payload) => payload.group_id && payload.video_id);

  const existingLogs = typeof dispatchLogs.listByCampaign === "function"
    ? await dispatchLogs.listByCampaign(campaignId)
    : [];
  let created = 0;

  for (const payload of logPayloads) {
    if (hasExistingDispatchLog(existingLogs, payload)) {
      continue;
    }

    const log = await dispatchLogs.createLog(payload);
    existingLogs.push(log || payload);
    created += 1;

    logger.info &&
      logger.info(
        JSON.stringify({
          event: "dispatch_log.pending_created",
          campaign_id: payload.campaign_id,
          group_id: payload.group_id,
          video_id: payload.video_id,
          log_id: log && log.id,
        })
      );
  }

  return {
    pending_logs_created: created,
    planned_schedule: plannedSchedule.map((item) => ({
      group_id: item.group_id,
      video_id: item.video_id,
      scheduled_at: item.scheduled_at,
      dispatch_order: item.dispatch_order,
    })),
    total_campaign_groups: campaignGroupRows.length,
    video_enabled_groups: groups.length,
    eligible_groups: dispatchableGroups.length,
    paused_groups: flow.pausedGroups.length,
    skipped_groups: flow.skippedGroups.length,
  };
}

function createCampaignTriggerProcessor(options = {}) {
  const {
    campaignGroups = campaignGroupsRepository,
    campaignVideoCaptionsRepository: campaignVideoCaptionsRepositoryOption = campaignVideoCaptionsRepository,
    campaigns = campaignsRepository,
    dispatchLogs = dispatchLogsRepository,
    trilhasRepository: trilhasRepositoryOption = trilhasRepository,
    videoFlowRepository = buildCampaignVideoFlowRepository(options),
    notificationsService = defaultNotificationsService,
    inAppNotificationsService = defaultInAppNotificationsService,
    settingsService: settingsServiceOption = defaultSettingsService,
    logger = console,
  } = options;
  const validateCampaignId = options.validateCampaignId ?? campaigns === campaignsRepository;

  return async function campaignTriggerWorker(job) {
    const startedAt = new Date().toISOString();

    await job.updateData({
      ...job.data,
      status: "processing",
      started_at: startedAt,
    });

    try {
      if (validateCampaignId && !UUID_PATTERN.test(String(job.data.campaign_id || ""))) {
        const completedAt = new Date().toISOString();
        const result = {
          campaign_id: job.data.campaign_id,
          status: "skipped",
          reason: "invalid_campaign_id",
          started_at: startedAt,
          completed_at: completedAt,
        };

        await job.updateData({
          ...job.data,
          status: "skipped",
          reason: "invalid_campaign_id",
          started_at: startedAt,
          completed_at: completedAt,
        });

        logger.warn &&
          logger.warn(
            JSON.stringify({
              event: "campaign_trigger.skipped_invalid_campaign_id",
              job_id: job.id,
              ...result,
            })
          );

        return result;
      }

      const campaign = campaigns && typeof campaigns.findById === "function"
        ? await campaigns.findById(job.data.campaign_id)
        : null;
      const campaignGroupRows = await campaignGroups.listGroups(job.data.campaign_id);
      const groupsWithFallback = await Promise.all(
        campaignGroupRows
          .map(extractCampaignGroup)
          .map((group) => applyCampaignTrailFallback(group, campaign, { trilhasRepository: trilhasRepositoryOption }))
      );
      const groups = groupsWithFallback.filter(isVideoEnabledGroup);
      const dispatchRules = await resolveDispatchRules(settingsServiceOption);
      const flow = await resolveGroupsVideoFlow({
        campaign_id: job.data.campaign_id,
        groups,
        repository: videoFlowRepository,
        dispatchRules,
        notificationsService,
        inAppNotificationsService,
        logger,
      });
      const dispatchableGroups = await filterGroupsMissingInstanceCoverage(flow.dispatchGroups, options, logger);
      const dispatchGroupsWithCaptions = await applyGeneratedCaptions(job.data.campaign_id, dispatchableGroups, {
        campaignVideoCaptionsRepository: campaignVideoCaptionsRepositoryOption,
      });
      const dispatchJobs = await enqueueResolvedDispatchJobs(job.data, dispatchGroupsWithCaptions, options);
      const pendingLogsCreated = await ensurePendingDispatchLogs(dispatchLogs, job.data.campaign_id, dispatchJobs, logger);
      await updateCampaignScheduledDispatch(campaigns, job.data.campaign_id, dispatchJobs, job.data.timezone);
      const completedAt = new Date().toISOString();
      const result = {
        campaign_id: job.data.campaign_id,
        status: "processed",
        started_at: startedAt,
        completed_at: completedAt,
        total_campaign_groups: campaignGroupRows.length,
        video_enabled_groups: groups.length,
        dispatch_enqueued: dispatchJobs.length,
        pending_logs_created: pendingLogsCreated,
        paused_groups: flow.pausedGroups.length,
        skipped_groups: flow.skippedGroups.length,
      };

      await job.updateData({
        ...job.data,
        status: "completed",
        started_at: startedAt,
        completed_at: completedAt,
        total_campaign_groups: result.total_campaign_groups,
        video_enabled_groups: result.video_enabled_groups,
        dispatch_enqueued: result.dispatch_enqueued,
        pending_logs_created: result.pending_logs_created,
        paused_groups: result.paused_groups,
        skipped_groups: result.skipped_groups,
      });

      logger.info &&
        logger.info(
          JSON.stringify({
            event: "campaign_trigger.processed",
            job_id: job.id,
            ...result,
          })
        );

      if (dispatchJobs.length > 0) {
        await notificationsService
          .notifyCampaignStarted({
            campaignId: job.data.campaign_id,
            campaignLabel: campaign && campaign.trilha,
            groupsCount: dispatchJobs.length,
          })
          .catch((notifyError) => {
            logger.error &&
              logger.error(
                JSON.stringify({
                  event: "campaign_trigger.notification_failed",
                  job_id: job.id,
                  campaign_id: job.data.campaign_id,
                  error_message: notifyError.message,
                })
              );
          });
      }

      return result;
    } catch (error) {
      const failedAt = new Date().toISOString();

      if (campaigns && typeof campaigns.update === "function" && UUID_PATTERN.test(String(job.data.campaign_id || ""))) {
        await campaigns.update(job.data.campaign_id, { ativo: false }).catch(() => undefined);
      }

      await job.updateData({
        ...job.data,
        status: "failed",
        started_at: startedAt,
        failed_at: failedAt,
        error_message: error.message,
      });

      logger.error &&
        logger.error(
          JSON.stringify({
            event: "campaign_trigger.failed",
            job_id: job.id,
            campaign_id: job.data.campaign_id,
            error_message: error.message,
          })
        );

      throw error;
    }
  };
}

function createCampaignTriggerWorker(processorOrOptions, options = {}) {
  if (typeof processorOrOptions === "function") {
    return createWorker(queueNames.campaignTrigger, processorOrOptions, options);
  }

  const workerOptions = processorOrOptions || {};
  const {
    campaignGroups,
    campaigns,
    dispatchLogs,
    videoCatalogRepository: injectedVideoCatalogRepository,
    groupVideoProgressRepository: injectedGroupVideoProgressRepository,
    trilhasRepository: injectedTrilhasRepository,
    videoFlowRepository,
    addDispatchJob: injectedAddDispatchJob,
    addJitteredDispatchJobs: injectedAddJitteredDispatchJobs,
    notificationsService,
    inAppNotificationsService,
    logger,
    ...bullmqOptions
  } = workerOptions;

  return createWorker(
    queueNames.campaignTrigger,
    createCampaignTriggerProcessor({
      campaignGroups,
      campaigns,
      dispatchLogs,
      videoCatalogRepository: injectedVideoCatalogRepository,
      groupVideoProgressRepository: injectedGroupVideoProgressRepository,
      trilhasRepository: injectedTrilhasRepository,
      videoFlowRepository,
      addDispatchJob: injectedAddDispatchJob,
      addJitteredDispatchJobs: injectedAddJitteredDispatchJobs,
      notificationsService,
      inAppNotificationsService,
      logger,
    }),
    bullmqOptions
  );
}

function createCampaignTriggerEvents(options = {}) {
  return createQueueEvents(queueNames.campaignTrigger, options);
}

module.exports = {
  CAMPAIGN_TRIGGER_ACTIVE_STATUS,
  CAMPAIGN_TRIGGER_INITIAL_STATUS,
  CAMPAIGN_TRIGGER_INACTIVE_STATUS,
  CAMPAIGN_TRIGGER_JOB_NAME,
  CAMPAIGN_TRIGGER_TYPE_RECURRING,
  addCampaignTriggerJob,
  applyCampaignTrailFallback,
  buildCampaignScheduleJobData,
  buildCampaignScheduleKey,
  buildCampaignTriggerJobData,
  buildCampaignVideoFlowRepository,
  createPendingDispatchLogsForCampaign,
  extractCampaignGroup,
  filterGroupsMissingInstanceCoverage,
  formatScheduledDateTime,
  ensurePendingDispatchLogs,
  isVideoEnabledGroup,
  get campaignTriggerQueue() {
    return getCampaignTriggerQueue();
  },
  createCampaignTriggerEvents,
  createCampaignTriggerProcessor,
  createCampaignTriggerWorker,
  disableCampaignSchedule,
  removeCampaignSchedule,
  scheduleCampaign,
};
