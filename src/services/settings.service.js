const settingsRepository = require("../repositories/settings.repository");
const videoCatalogRepository = require("../repositories/video-catalog.repository");
const groupsRepository = require("../repositories/groups.repository");
const {
  ALLOWED_GEMINI_MODELS,
  normalizeAgentSettings,
} = require("./ai/ai-settings.service");
const {
  DEFAULT_CAPTION_GENERATION_PROMPT,
  DEFAULT_CAPTION_REVIEW_PROMPT,
} = require("./ai/constants");

const DEFAULT_AGENT_PROMPTS = {
  caption_generation: DEFAULT_CAPTION_GENERATION_PROMPT,
  caption_review: DEFAULT_CAPTION_REVIEW_PROMPT,
};
const {
  buildDriveFolderUrl,
  createGoogleDriveClient,
  extractDriveFolderId,
  resolveServiceAccountCredentials,
} = require("./google-drive");
const { indexGoogleDriveVideos } = require("./google-drive-video-indexer");
const {
  createGoogleDriveVideoIndexStateStore,
} = require("./google-drive-video-index-state");

function loadGoogleDriveVideoIndexQueueModule() {
  return require("../queues/google-drive-video-index");
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

const DEFAULT_SCHEDULE_TIMEZONE = "America/Sao_Paulo";
const DEFAULT_SCHEDULE_MIN_INTERVAL_MIN = 4;
const DEFAULT_SCHEDULE_MAX_INTERVAL_MIN = 12;
const DEFAULT_NOTIFICATION_EVENTS = {
  campaignStarted: true,
  campaignFinished: true,
  dispatchFailure: true,
  aiError: true,
  trailFinished: true,
};
const DEFAULT_DISPATCH_RULES = {
  never_repeat_video: true,
  notify_on_trail_finished: true,
  auto_generate_caption: true,
  require_human_review: true,
  auto_send_after_timeout: { enabled: false, minutes: 60 },
  auto_retry_failures: true,
  // Motor de sequenciamento automatico de trilhas (ordem por perfil + desvios por
  // setor + checkpoint de proximo perfil) - ligado por padrao porque e o novo
  // comportamento esperado do envio automatizado; desligar volta ao fluxo manual
  // de sempre (grupo pausa ao terminar a trilha, operador escolhe a proxima).
  auto_advance_trilha: true,
  notify_on_trail_advanced: true,
};

function buildDailyCronExpression(hour, minute) {
  return `${minute} ${hour} * * *`;
}

function parseDailyCronExpression(cronExpression) {
  const parts = String(cronExpression || "").trim().split(/\s+/);

  if (parts.length !== 5) {
    return { hour: null, minute: null };
  }

  const [minutePart, hourPart] = parts;
  const minute = Number(minutePart);
  const hour = Number(hourPart);

  if (!Number.isInteger(minute) || !Number.isInteger(hour)) {
    return { hour: null, minute: null };
  }

  return { hour, minute };
}

function createSettingsService(dependencies = {}) {
  const repository = dependencies.settingsRepository || settingsRepository;
  const videoRepository = dependencies.videoCatalogRepository || videoCatalogRepository;
  const groupsRepositoryDependency = dependencies.groupsRepository || groupsRepository;
  const buildDriveClient = dependencies.createGoogleDriveClient || createGoogleDriveClient;
  const loadCredentials = dependencies.resolveServiceAccountCredentials || resolveServiceAccountCredentials;
  const indexer = dependencies.indexGoogleDriveVideos || indexGoogleDriveVideos;
  const stateStore = dependencies.stateStore || createGoogleDriveVideoIndexStateStore();

  let lazyUpsertVideo;

  function resolveUpsertVideo() {
    if (dependencies.upsertVideo) {
      return dependencies.upsertVideo;
    }

    if (!lazyUpsertVideo) {
      lazyUpsertVideo = loadGoogleDriveVideoIndexQueueModule().createDefaultVideoUpsert(videoRepository);
    }

    return lazyUpsertVideo;
  }

  async function scheduleIndexJob(...args) {
    if (dependencies.scheduleGoogleDriveVideoIndexJob) {
      return dependencies.scheduleGoogleDriveVideoIndexJob(...args);
    }

    return loadGoogleDriveVideoIndexQueueModule().scheduleGoogleDriveVideoIndexJob(...args);
  }

  function resolveServiceAccountEmail() {
    try {
      const credentials = loadCredentials();

      return credentials && credentials.client_email ? credentials.client_email : null;
    } catch (error) {
      return null;
    }
  }

  async function getDriveSettings() {
    const settings = await repository.getSettings();
    const { hour, minute } = parseDailyCronExpression(settings && settings.drive_index_cron);
    const rootFolderId = (settings && settings.drive_root_folder_id) || null;

    return {
      root_folder_id: rootFolderId,
      root_folder_url: buildDriveFolderUrl(rootFolderId),
      service_account_email: resolveServiceAccountEmail(),
      index_hour: hour,
      index_minute: minute,
      timezone: (settings && settings.drive_index_timezone) || null,
    };
  }

  async function testDatabaseConnection() {
    const startedAt = Date.now();

    try {
      await repository.getSettings();

      return { connected: true, latency_ms: Date.now() - startedAt };
    } catch (error) {
      return { connected: false, reason: error.message };
    }
  }

  async function testDriveConnection() {
    const settings = await repository.getSettings();
    const rootFolderId = settings && settings.drive_root_folder_id;

    if (!rootFolderId) {
      return { connected: false, reason: "Nenhuma pasta raiz configurada" };
    }

    try {
      const drive = buildDriveClient();
      const response = await drive.files.get({
        fileId: rootFolderId,
        fields: "id, name",
        supportsAllDrives: true,
      });

      return { connected: true, folder_name: response.data.name };
    } catch (error) {
      return { connected: false, reason: error.message };
    }
  }

  async function updateDriveRootFolder(input = {}) {
    const rawValue = input.folder_url_or_id;

    if (!rawValue || !String(rawValue).trim()) {
      throw new Error("folder_url_or_id is required");
    }

    const folderId = extractDriveFolderId(rawValue);

    await repository.updateSettings({ drive_root_folder_id: folderId });

    return getDriveSettings();
  }

  async function updateDriveIndexSchedule(input = {}) {
    const hour = Number(input.hour);
    const minute = Number(input.minute);

    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new Error("hour must be an integer between 0 and 23");
    }

    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw new Error("minute must be an integer between 0 and 59");
    }

    const timezone = input.timezone || undefined;
    const cronExpression = buildDailyCronExpression(hour, minute);

    await repository.updateSettings({
      drive_index_cron: cronExpression,
      drive_index_timezone: timezone || null,
    });

    await scheduleIndexJob({ cron_expression: cronExpression, timezone });

    return getDriveSettings();
  }

  const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

  function normalizeDispatchPeriods(rawPeriods) {
    if (!Array.isArray(rawPeriods)) {
      return [];
    }

    return rawPeriods
      .filter((period) => period && typeof period === "object")
      .map((period) => ({ inicio: String(period.inicio || ""), fim: String(period.fim || "") }));
  }

  function assertValidDispatchPeriods(periods) {
    for (const period of periods) {
      if (!TIME_OF_DAY_PATTERN.test(period.inicio) || !TIME_OF_DAY_PATTERN.test(period.fim)) {
        throw new Error("dispatch_periods entries must have valid inicio/fim times (HH:mm)");
      }

      if (period.inicio >= period.fim) {
        throw new Error("dispatch_periods entries must have inicio earlier than fim");
      }
    }
  }

  async function getScheduleSettings() {
    const settings = await repository.getSettings();

    return {
      timezone: (settings && settings.default_timezone) || DEFAULT_SCHEDULE_TIMEZONE,
      min_interval_min: Number.isInteger(settings && settings.default_min_interval_min)
        ? settings.default_min_interval_min
        : DEFAULT_SCHEDULE_MIN_INTERVAL_MIN,
      max_interval_min: Number.isInteger(settings && settings.default_max_interval_min)
        ? settings.default_max_interval_min
        : DEFAULT_SCHEDULE_MAX_INTERVAL_MIN,
      dispatch_periods: normalizeDispatchPeriods(settings && settings.default_dispatch_periods),
    };
  }

  async function updateScheduleSettings(input = {}) {
    const timezone = String(input.timezone || "").trim();
    const minInterval = Number(input.min_interval_min);
    const maxInterval = Number(input.max_interval_min);

    if (!timezone) {
      throw new Error("timezone is required");
    }

    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
    } catch (error) {
      throw new Error("timezone is invalid");
    }

    if (!Number.isInteger(minInterval) || minInterval < 1) {
      throw new Error("min_interval_min must be an integer greater than or equal to 1");
    }

    if (!Number.isInteger(maxInterval) || maxInterval < minInterval) {
      throw new Error("max_interval_min must be an integer greater than or equal to min_interval_min");
    }

    const dispatchPeriods = normalizeDispatchPeriods(input.dispatch_periods);
    assertValidDispatchPeriods(dispatchPeriods);

    await repository.updateSettings({
      default_timezone: timezone,
      default_min_interval_min: minInterval,
      default_max_interval_min: maxInterval,
      default_dispatch_periods: dispatchPeriods,
    });

    return getScheduleSettings();
  }

  async function reindexDriveNow() {
    const settings = await repository.getSettings();
    const rootFolderId = settings && settings.drive_root_folder_id;

    if (!rootFolderId) {
      throw new Error("Drive root folder is not configured");
    }

    const drive = buildDriveClient();
    const startedAt = new Date().toISOString();
    const upsertVideo = resolveUpsertVideo();

    let createdCount = 0;
    let updatedCount = 0;

    async function countingUpsertVideo(video) {
      const upsertResult = await upsertVideo(video);

      if (upsertResult && upsertResult.created) {
        createdCount += 1;
      } else {
        updatedCount += 1;
      }

      return upsertResult;
    }

    const result = await indexer({
      drive,
      rootFolderId,
      rootFolderName: "root",
      upsertVideo: countingUpsertVideo,
    });

    const existingVideos = await videoRepository.findAllDriveFileIds();
    const seenDriveFileIds = new Set(result.videos.map((video) => video.drive_file_id));
    const removedVideos = existingVideos.filter((video) => !seenDriveFileIds.has(video.drive_file_id));

    await Promise.all(removedVideos.map((video) => videoRepository.remove(video.id)));

    await stateStore.saveSuccessfulIndex({
      rootFolderId,
      rootFolderName: "root",
      indexedAt: startedAt,
      completedAt: new Date().toISOString(),
      processedCount: result.processed_count,
      indexedCount: result.indexed_count,
      skippedCount: result.skipped_count,
      errorCount: result.error_count,
    });

    return {
      created: createdCount,
      updated: updatedCount,
      processed: result.processed_count,
      indexed: result.indexed_count,
      skipped: result.skipped_count,
      errors: result.error_count,
      removed: removedVideos.length,
    };
  }

  async function getNotificationSettings() {
    const settings = await repository.getSettings();
    const groupId = (settings && settings.notification_group_id) || null;
    const group = groupId ? await groupsRepositoryDependency.findById(groupId) : null;

    return {
      notification_group_id: groupId,
      notification_group_name: group ? group.nome : null,
      events: { ...DEFAULT_NOTIFICATION_EVENTS, ...((settings && settings.notification_events) || {}) },
    };
  }

  async function updateNotificationSettings(input = {}) {
    const hasGroupId = Object.prototype.hasOwnProperty.call(input, "notification_group_id");
    const updatePayload = {};

    if (hasGroupId) {
      const groupId = input.notification_group_id;

      if (groupId !== null && typeof groupId !== "string") {
        throw new Error("notification_group_id must be a string or null");
      }

      const normalizedGroupId = typeof groupId === "string" ? groupId.trim() : groupId;

      if (normalizedGroupId) {
        const group = await groupsRepositoryDependency.findById(normalizedGroupId);

        if (!group) {
          throw new Error("Group not found");
        }
      }

      updatePayload.notification_group_id = normalizedGroupId || null;
    }

    if (input.events && typeof input.events === "object") {
      const current = await getNotificationSettings();

      updatePayload.notification_events = { ...current.events, ...input.events };
    }

    if (Object.keys(updatePayload).length > 0) {
      await repository.updateSettings(updatePayload);
    }

    return getNotificationSettings();
  }

  async function getAIAgentsSettings() {
    const settings = await repository.getSettings();
    const stored = (settings && settings.ai_agents) || {};

    return {
      transcription: normalizeAgentSettings("transcription", stored.transcription),
      caption_generation: {
        ...normalizeAgentSettings("caption_generation", stored.caption_generation),
        default_prompt: DEFAULT_AGENT_PROMPTS.caption_generation,
      },
      caption_review: {
        ...normalizeAgentSettings("caption_review", stored.caption_review),
        default_prompt: DEFAULT_AGENT_PROMPTS.caption_review,
      },
    };
  }

  function assertValidAgentInput(agentKey, agentInput) {
    if (!Array.isArray(agentInput.models) || !agentInput.models.length) {
      throw new Error(`${agentKey}.models must be a non-empty array`);
    }

    const invalidModel = agentInput.models.find((model) => !ALLOWED_GEMINI_MODELS.includes(model));

    if (invalidModel) {
      throw new Error(`${agentKey}.models contains an unsupported model: ${invalidModel}`);
    }

    if (
      Object.prototype.hasOwnProperty.call(agentInput, "prompt") &&
      agentInput.prompt !== null &&
      typeof agentInput.prompt !== "string"
    ) {
      throw new Error(`${agentKey}.prompt must be a string or null`);
    }
  }

  async function updateAIAgentsSettings(input = {}) {
    const current = await getAIAgentsSettings();
    const next = { ...current };

    for (const agentKey of ["transcription", "caption_generation", "caption_review"]) {
      const agentInput = input[agentKey];

      if (!agentInput) {
        continue;
      }

      assertValidAgentInput(agentKey, agentInput);

      next[agentKey] = {
        models: agentInput.models,
        ...(agentKey === "transcription"
          ? {}
          : { prompt: Object.prototype.hasOwnProperty.call(agentInput, "prompt") ? agentInput.prompt : current[agentKey].prompt }),
      };
    }

    await repository.updateSettings({ ai_agents: next });

    return getAIAgentsSettings();
  }

  async function getDispatchRulesSettings() {
    const settings = await repository.getSettings();

    return {
      ...DEFAULT_DISPATCH_RULES,
      ...((settings && settings.dispatch_rules) || {}),
    };
  }

  function assertValidDispatchRulesInput(input) {
    const booleanFields = [
      "never_repeat_video",
      "notify_on_trail_finished",
      "auto_generate_caption",
      "require_human_review",
      "auto_retry_failures",
      "auto_advance_trilha",
      "notify_on_trail_advanced",
    ];

    for (const field of booleanFields) {
      if (Object.prototype.hasOwnProperty.call(input, field) && typeof input[field] !== "boolean") {
        throw new Error(`${field} must be a boolean`);
      }
    }

    if (Object.prototype.hasOwnProperty.call(input, "auto_send_after_timeout")) {
      const timeout = input.auto_send_after_timeout;

      if (!timeout || typeof timeout !== "object") {
        throw new Error("auto_send_after_timeout must be an object");
      }

      if (Object.prototype.hasOwnProperty.call(timeout, "enabled") && typeof timeout.enabled !== "boolean") {
        throw new Error("auto_send_after_timeout.enabled must be a boolean");
      }

      if (
        Object.prototype.hasOwnProperty.call(timeout, "minutes") &&
        (!Number.isInteger(timeout.minutes) || timeout.minutes < 1)
      ) {
        throw new Error("auto_send_after_timeout.minutes must be an integer greater than or equal to 1");
      }
    }
  }

  async function updateDispatchRulesSettings(input = {}) {
    assertValidDispatchRulesInput(input);

    const current = await getDispatchRulesSettings();
    const next = { ...current, ...input };

    if (input.auto_send_after_timeout) {
      next.auto_send_after_timeout = {
        ...current.auto_send_after_timeout,
        ...input.auto_send_after_timeout,
      };
    }

    await repository.updateSettings({ dispatch_rules: next });

    return getDispatchRulesSettings();
  }

  return {
    getAIAgentsSettings,
    getDispatchRulesSettings,
    getDriveSettings,
    getNotificationSettings,
    getScheduleSettings,
    reindexDriveNow,
    testDatabaseConnection,
    testDriveConnection,
    updateAIAgentsSettings,
    updateDispatchRulesSettings,
    updateDriveIndexSchedule,
    updateDriveRootFolder,
    updateNotificationSettings,
    updateScheduleSettings,
  };
}

module.exports = createSettingsService();
module.exports.createSettingsService = createSettingsService;
