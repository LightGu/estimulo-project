const { createQueue, createQueueEvents, createWorker } = require("./bullmq");
const { addDispatchJob, addJitteredDispatchJobs } = require("./dispatch");
const { buildJitteredDispatchSchedule, resolveInstanceForOrder } = require("./dispatch-jitter");
const campaignGroupsRepository = require("../repositories/campaign-groups.repository");
const campaignVideoCaptionsRepository = require("../repositories/campaign-video-captions.repository");
const campaignsRepository = require("../repositories/campaigns.repository");
const dispatchLogsRepository = require("../repositories/dispatch-logs.repository");
const groupsRepository = require("../repositories/groups.repository");
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
const {
  resolveLogScheduledAt,
  resolveMaxVideoDispatchDelayMs,
  resolveStaleDispatchReason,
} = require("../services/dispatch-staleness");
const { queueNames } = require("./names");
const { UUID_PATTERN } = require("../utils/uuid");
const {
  CAMPAIGN_TRIGGER_ACTIVE_STATUS,
  CAMPAIGN_TRIGGER_INACTIVE_STATUS,
  CAMPAIGN_TRIGGER_INITIAL_STATUS,
  CAMPAIGN_TRIGGER_JOB_NAME,
  CAMPAIGN_TRIGGER_TYPE_RECURRING,
  DEFAULT_CAMPAIGN_TIMEZONE,
  assertCampaignId,
  buildCampaignScheduleJobData,
  buildCampaignScheduleKey,
  buildCampaignTriggerJobData,
  buildCampaignTriggerJobOptions,
  formatScheduledDateTime,
  getCampaignTimezone,
  normalizeBooleanStatus,
  normalizeDateField,
  normalizeDispatchJitter,
  normalizeExecutionDate,
  normalizePrecomputedSchedule,
  normalizeRepeatOptions,
  normalizeTimeWindow,
} = require("./campaign-schedule-params");


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

async function resolveDispatchRules(settingsService = defaultSettingsService, logger = console) {
  try {
    return await settingsService.getDispatchRulesSettings();
  } catch (error) {
    // O fallback para {} continua (a campanha nao deve parar por causa das
    // settings), mas antes era mudo: never_repeat_video, auto_retry_failures e
    // auto_send_after_timeout voltavam ao default sem ninguem saber, e um video
    // podia ser reenviado a um grupo com "nunca repetir" ligado.
    logger &&
      logger.warn &&
      logger.warn(
        JSON.stringify({
          event: "campaign_trigger.dispatch_rules_unavailable",
          error_message: error && error.message,
        })
      );

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

// Best-effort: grava o id do job do BullMQ no log correspondente, para o
// resume conseguir localiza-lo direto (queue.getJob(id)) em vez de escanear a
// fila. Perder este id so degrada o resume para o caminho de recriar o job do
// zero - nunca pode impedir o envio atual.
async function recordDispatchJobId(dispatchLogs, log, job, logger = console) {
  if (!log || !log.id || !job || !job.id || typeof dispatchLogs.updateDispatchJobId !== "function") {
    return;
  }

  try {
    await dispatchLogs.updateDispatchJobId(log.id, job.id);
  } catch (error) {
    logger.error &&
      logger.error(
        JSON.stringify({
          event: "dispatch_log.record_job_id_failed",
          log_id: log.id,
          job_id: job.id,
          error_message: error.message,
        })
      );
  }
}

async function ensurePendingDispatchLogs(dispatchLogs, campaignId, dispatchJobs, logger = console) {
  if (!dispatchLogs || typeof dispatchLogs.createLog !== "function" || !Array.isArray(dispatchJobs)) {
    return 0;
  }

  const entries = dispatchJobs
    .map((job) => ({ job, payload: extractDispatchLogPayloadFromJob(job) }))
    .filter((entry) => entry.payload);

  if (entries.length === 0) {
    return 0;
  }

  const existingLogs = typeof dispatchLogs.listByCampaign === "function"
    ? await dispatchLogs.listByCampaign(campaignId)
    : [];
  let created = 0;

  for (const { job, payload } of entries) {
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
      await recordDispatchJobId(dispatchLogs, existingLog, job, logger);
      continue;
    }

    const log = await dispatchLogs.createLog(payload);
    existingLogs.push(log || payload);
    created += 1;
    await recordDispatchJobId(dispatchLogs, log, job, logger);

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

// Usado pelo resumeCampaign quando o campaign-trigger ja tinha disparado (ja
// existiam jobs de disparo por grupo) e o job original de algum log pendente
// nao sobreviveu no Redis (ex.: ja tinha disparado-e-virado-no-op durante a
// pausa). Recria o job so para esses logs, reaproveitando video/legenda ja
// fixados no log - nao pode re-resolver "proximo video", so reenviar o que ja
// estava decidido.
async function requeuePendingDispatchJobsForCampaign(campaignId, pendingLogs, options = {}) {
  const {
    groupsRepository: groupsRepositoryOption = groupsRepository,
    videoCatalogRepository: videoCatalogRepositoryOption = videoCatalogRepository,
    campaignVideoCaptionsRepository: campaignVideoCaptionsRepositoryOption = campaignVideoCaptionsRepository,
    dispatchLogs: dispatchLogsOption = dispatchLogsRepository,
    addDispatchJob: addSingleDispatchJob = addDispatchJob,
    logger = console,
  } = options;

  if (!Array.isArray(pendingLogs) || pendingLogs.length === 0) {
    return [];
  }

  const { whatsappInstances, rotationGroupCount } = await resolveActiveInstancesAndRotation(options);
  const captionRows = typeof campaignVideoCaptionsRepositoryOption.listByCampaign === "function"
    ? await campaignVideoCaptionsRepositoryOption.listByCampaign(campaignId)
    : [];
  const captionByKey = new Map(
    captionRows
      .filter((row) => row.status === "gerado" && row.caption_text)
      .map((row) => [`${row.group_id}::${row.video_id}`, row])
  );

  const jobs = [];

  for (const [index, log] of pendingLogs.entries()) {
    try {
      // Horario original do log, nunca "agora": passar null adiante faria
      // buildDispatchJobData assumir o default `new Date()` e o envio antigo
      // voltaria para a fila parecendo recem-agendado, driblando a trava de
      // atraso. Sem horario em que ancorar, o log exige acao manual.
      const logScheduledAt = resolveLogScheduledAt(log);

      if (!logScheduledAt) {
        logger.warn &&
          logger.warn(
            JSON.stringify({
              event: "campaign_trigger.requeue_skipped_sem_horario",
              campaign_id: campaignId,
              log_id: log.id,
              group_id: log.group_id,
              note: "log sem horario_envio_planejado nem criado_em; reenviar exigiria inventar um horario",
            })
          );
        continue;
      }

      const group = await groupsRepositoryOption.findById(log.group_id);

      if (!group || !group.evolution_group_id) {
        logger.warn &&
          logger.warn(
            JSON.stringify({
              event: "campaign_trigger.requeue_skipped_missing_group",
              campaign_id: campaignId,
              log_id: log.id,
              group_id: log.group_id,
            })
          );
        continue;
      }

      const video = log.video_id && typeof videoCatalogRepositoryOption.findById === "function"
        ? await videoCatalogRepositoryOption.findById(log.video_id)
        : null;
      const caption = captionByKey.get(`${log.group_id}::${log.video_id}`);
      const dispatchOrder = index + 1;

      const job = await addSingleDispatchJob({
        group_id: group.evolution_group_id,
        progress_group_id: log.group_id,
        campaign_id: campaignId,
        video_id: log.video_id,
        drive_file_id: video && video.drive_file_id,
        video_catalog: video || undefined,
        trilha_id: group.trilha_id,
        legenda: (caption && caption.caption_text) || "",
        caption_id: caption && caption.id,
        caption_generated: Boolean(caption),
        scheduled_at: logScheduledAt,
        dispatch_order: dispatchOrder,
        whatsapp_instance_id: resolveInstanceForOrder(dispatchOrder, whatsappInstances, rotationGroupCount),
      });

      jobs.push(job);
      await recordDispatchJobId(dispatchLogsOption, log, job, logger);
    } catch (error) {
      logger.error &&
        logger.error(
          JSON.stringify({
            event: "campaign_trigger.requeue_dispatch_job_failed",
            campaign_id: campaignId,
            log_id: log.id,
            error_message: error.message,
          })
        );
    }
  }

  return jobs;
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
      usuario_responsavel_id: options.usuario_responsavel_id || null,
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

// Trava de atraso do trigger de campanha.
//
// Este e o caminho que gerou a rajada de mensagens ao subir o Docker: um job de
// trigger agendado dias antes fica gravado no Redis (a infra usa
// `--appendonly yes` com volume), e quando o worker volta a BullMQ o promove na
// hora. O processor entao monta os jobs por grupo com os horarios da janela
// original - toda ela no passado - e buildDispatchJobOptions calcula
// `Math.max(scheduled - agora, 0)` = delay 0 para TODOS os grupos. Resultado:
// dezenas de envios simultaneos de uma campanha antiga.
//
// Jobs recorrentes (repeat/cron) ficam de fora de proposito: neles o disparo do
// cron E o horario legitimo, e a janela gravada no job e a do cadastro - compara-la
// com "agora" bloquearia toda campanha recorrente valida.
// LIMITACAO CONHECIDA desta isencao (nao alcancavel pelo app hoje).
//
// Um agendamento recorrente que ficou parado no Redis enquanto os workers
// estavam fora do ar dispara a campanha inteira no proximo boot: o job e'
// promovido, cai no `return null` abaixo, e como buildCampaignScheduleJobData
// nao grava `execution_at` em job recorrente, enqueueResolvedDispatchJobs cai
// no `|| new Date()` - todo scheduled_at sai recem-carimbado e a trava de
// atraso de dispatch.js nao ve atraso nenhum.
//
// Por que nao esta corrigido: `scheduleCampaign` (a unica funcao que cria job
// recorrente) nao e' chamada por nenhuma rota, controller ou service - so pelos
// scripts manuais scripts/enqueue-campaign-trigger.js e
// scripts/test-campaign-trigger-recurring.js. E as filas foram inspecionadas em
// 23/08/2026 com zero agendamentos recorrentes armados. A defesa que contem o
// resto e' claimTriggerFired (campaigns.repository.js), atomico, que impede uma
// campanha ja disparada de disparar de novo - resta exposta apenas a campanha
// recorrente que nunca chegou a disparar.
//
// Corrigir exige ancorar a trava em `job.opts.repeat.prevMillis` /
// `job.timestamp` em vez de exigir `execution_at`; ancorar errado bloqueia toda
// campanha recorrente legitima, que e' o motivo original da isencao.
function resolveTriggerStaleReason(jobData = {}, options = {}) {
  if (jobData.trigger_type === CAMPAIGN_TRIGGER_TYPE_RECURRING) {
    return null;
  }

  const windowEnd = jobData.time_window && (jobData.time_window.end || jobData.time_window.end_at);
  // Compara com o horario MAIS TARDE que o job admite: se nem ele ainda e
  // valido, a execucao esta vencida por completo. `time_window.end` entra so
  // quando e uma data completa - a janela tambem aceita hora-solta ("10:00"),
  // que nao da para comparar com "agora"; nesse caso execution_at governa
  // (normalizeExecutionDate garante que ele e sempre uma data valida).
  const referenceMs = [jobData.execution_at, windowEnd]
    .map((value) => (value ? new Date(value).getTime() : Number.NaN))
    .filter((value) => Number.isFinite(value));

  if (!referenceMs.length) {
    return null;
  }

  return resolveStaleDispatchReason(new Date(Math.max(...referenceMs)), {
    maxDelayMs: resolveMaxVideoDispatchDelayMs(),
    ...options,
  });
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
    now = () => new Date(),
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
      // Antes de qualquer coisa: um trigger vencido nao pode virar dezenas de
      // jobs de disparo com delay 0. Barrar aqui (e nao so no worker de dispatch)
      // evita tambem os efeitos colaterais que o trigger produz antes do envio -
      // criar logs "pendente" para todos os grupos, reivindicar trigger_fired_at
      // e mandar a notificacao de "campanha iniciada" no WhatsApp.
      const triggerStaleReason = resolveTriggerStaleReason(job.data, { now });

      if (triggerStaleReason) {
        const completedAt = new Date().toISOString();
        const result = {
          campaign_id: job.data.campaign_id,
          status: "skipped",
          reason: "trigger_stale",
          detail: triggerStaleReason,
          started_at: startedAt,
          completed_at: completedAt,
        };

        await job.updateData({ ...job.data, ...result });

        logger.warn &&
          logger.warn(
            JSON.stringify({
              event: "campaign_trigger.skipped_stale",
              job_id: job.id,
              execution_at: job.data.execution_at,
              window_end: job.data.time_window && job.data.time_window.end,
              ...result,
            })
          );

        return result;
      }

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

      if (campaign && (campaign.status === "pausado" || campaign.status === "cancelado")) {
        const completedAt = new Date().toISOString();
        const result = {
          campaign_id: job.data.campaign_id,
          status: "skipped",
          reason: campaign.status === "pausado" ? "campaign_paused" : "campaign_cancelled",
          started_at: startedAt,
          completed_at: completedAt,
        };

        await job.updateData({ ...job.data, ...result });

        logger.warn &&
          logger.warn(
            JSON.stringify({
              event: "campaign_trigger.skipped_campaign_not_active",
              job_id: job.id,
              ...result,
            })
          );

        return result;
      }

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

      // Reivindicacao atomica: so cria os jobs de disparo se ainda for a
      // primeira vez (trigger_fired_at nulo) e a campanha nao tiver sido
      // pausada/cancelada entre a checagem acima e este ponto. Fecha a corrida
      // de um segundo job de trigger perdido para a mesma campanha, e a janela
      // entre a checagem de status e a criacao efetiva dos jobs.
      if (campaigns && typeof campaigns.claimTriggerFired === "function") {
        const claimedCampaign = await campaigns.claimTriggerFired(job.data.campaign_id);

        if (!claimedCampaign) {
          const completedAt = new Date().toISOString();
          const result = {
            campaign_id: job.data.campaign_id,
            status: "skipped",
            reason: "trigger_already_claimed_or_not_active",
            started_at: startedAt,
            completed_at: completedAt,
          };

          await job.updateData({ ...job.data, ...result });

          logger.warn &&
            logger.warn(
              JSON.stringify({
                event: "campaign_trigger.skipped_claim_lost",
                job_id: job.id,
                ...result,
              })
            );

          return result;
        }
      }

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
  requeuePendingDispatchJobsForCampaign,
  resolveTriggerStaleReason,
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
