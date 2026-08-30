const assert = require("node:assert/strict");

const { createSettingsService } = require("../src/services/settings.service");

async function main() {
  // ---------- getDriveSettings ----------
  {
    const settingsRepository = {
      getSettings: async () => ({
        drive_root_folder_id: "folder-1",
        drive_index_cron: "15 3 * * *",
        drive_index_timezone: "America/Bahia",
      }),
    };

    const service = createSettingsService({
      settingsRepository,
      resolveServiceAccountCredentials: () => ({ client_email: "svc@example.iam.gserviceaccount.com" }),
    });

    const settings = await service.getDriveSettings();
    assert.equal(settings.root_folder_id, "folder-1");
    assert.equal(settings.root_folder_url, "https://drive.google.com/drive/folders/folder-1");
    assert.equal(settings.service_account_email, "svc@example.iam.gserviceaccount.com");
    assert.equal(settings.index_hour, 3);
    assert.equal(settings.index_minute, 15);
    assert.equal(settings.timezone, "America/Bahia");
  }

  // ---------- updateDriveRootFolder ----------
  {
    const updateCalls = [];
    const settingsRepository = {
      getSettings: async () => ({ drive_root_folder_id: "folder-2" }),
      updateSettings: async (payload) => {
        updateCalls.push(payload);
        return { ...payload };
      },
    };

    const service = createSettingsService({
      settingsRepository,
      resolveServiceAccountCredentials: () => ({ client_email: "svc@example.iam.gserviceaccount.com" }),
    });

    await service.updateDriveRootFolder({
      folder_url_or_id: "https://drive.google.com/drive/folders/folder-2?usp=sharing",
    });

    assert.equal(updateCalls[0].drive_root_folder_id, "folder-2");

    await assert.rejects(() => service.updateDriveRootFolder({}), /folder_url_or_id is required/);
  }

  // ---------- updateDriveIndexSchedule ----------
  {
    const updateCalls = [];
    const scheduleCalls = [];
    const settingsRepository = {
      getSettings: async () => ({ drive_index_cron: "0 5 * * *" }),
      updateSettings: async (payload) => {
        updateCalls.push(payload);
        return payload;
      },
    };

    const service = createSettingsService({
      settingsRepository,
      resolveServiceAccountCredentials: () => null,
      scheduleGoogleDriveVideoIndexJob: async (params) => {
        scheduleCalls.push(params);
        return { id: "job-1" };
      },
    });

    await service.updateDriveIndexSchedule({ hour: 5, minute: 30, timezone: "America/Bahia" });

    assert.equal(updateCalls[0].drive_index_cron, "30 5 * * *");
    assert.equal(scheduleCalls[0].cron_expression, "30 5 * * *");
    assert.equal(scheduleCalls[0].timezone, "America/Bahia");

    await assert.rejects(() => service.updateDriveIndexSchedule({ hour: 24, minute: 0 }), /hour must be an integer/);
    await assert.rejects(() => service.updateDriveIndexSchedule({ hour: 0, minute: 60 }), /minute must be an integer/);
  }

  // ---------- testDriveConnection ----------
  {
    const settingsRepository = {
      getSettings: async () => ({ drive_root_folder_id: "folder-1" }),
    };

    const connectedService = createSettingsService({
      settingsRepository,
      createGoogleDriveClient: () => ({
        files: {
          get: async () => ({ data: { id: "folder-1", name: "Trilhas de Video" } }),
        },
      }),
    });

    const connectedResult = await connectedService.testDriveConnection();
    assert.equal(connectedResult.connected, true);
    assert.equal(connectedResult.folder_name, "Trilhas de Video");

    const failingService = createSettingsService({
      settingsRepository,
      createGoogleDriveClient: () => ({
        files: {
          get: async () => {
            throw new Error("File not found");
          },
        },
      }),
    });

    const failingResult = await failingService.testDriveConnection();
    assert.equal(failingResult.connected, false);
    assert.equal(failingResult.reason, "File not found");

    const noFolderService = createSettingsService({
      settingsRepository: { getSettings: async () => ({}) },
    });

    const noFolderResult = await noFolderService.testDriveConnection();
    assert.equal(noFolderResult.connected, false);
  }

  // ---------- testDatabaseConnection ----------
  {
    const connectedService = createSettingsService({
      settingsRepository: { getSettings: async () => ({ key: "global" }) },
    });

    const connectedResult = await connectedService.testDatabaseConnection();
    assert.equal(connectedResult.connected, true);
    assert.equal(typeof connectedResult.latency_ms, "number");

    const failingService = createSettingsService({
      settingsRepository: {
        getSettings: async () => {
          throw new Error("Connection refused");
        },
      },
    });

    const failingResult = await failingService.testDatabaseConnection();
    assert.equal(failingResult.connected, false);
    assert.equal(failingResult.reason, "Connection refused");
  }

  // ---------- reindexDriveNow ----------
  {
    const settingsRepository = {
      getSettings: async () => ({ drive_root_folder_id: "folder-1" }),
    };

    const removedIds = [];
    const videoCatalogRepository = {
      findAllDriveFileIds: async () => [
        { id: "video-kept", drive_file_id: "drive-kept" },
        { id: "video-removed", drive_file_id: "drive-removed" },
      ],
      remove: async (id) => {
        removedIds.push(id);
        return { id };
      },
    };

    const service = createSettingsService({
      settingsRepository,
      videoCatalogRepository,
      createGoogleDriveClient: () => ({}),
      indexGoogleDriveVideos: async ({ upsertVideo }) => {
        await upsertVideo({ drive_file_id: "drive-kept" });
        await upsertVideo({ drive_file_id: "drive-new" });

        return {
          videos: [{ drive_file_id: "drive-kept" }, { drive_file_id: "drive-new" }],
          processed_count: 2,
          indexed_count: 2,
          skipped_count: 0,
          error_count: 0,
        };
      },
      upsertVideo: async (video) => ({
        created: video.drive_file_id === "drive-new",
        video,
      }),
      stateStore: {
        saveSuccessfulIndex: async () => {},
      },
    });

    const result = await service.reindexDriveNow();

    assert.equal(result.created, 1);
    assert.equal(result.updated, 1);
    assert.equal(result.removed, 1);
    assert.deepEqual(removedIds, ["video-removed"]);

    const noFolderService = createSettingsService({
      settingsRepository: { getSettings: async () => ({}) },
    });

    await assert.rejects(() => noFolderService.reindexDriveNow(), /Drive root folder is not configured/);
  }

  // ---------- getScheduleSettings ----------
  {
    const service = createSettingsService({
      settingsRepository: {
        getSettings: async () => ({
          default_timezone: "America/Manaus",
          default_min_interval_min: 5,
          default_max_interval_min: 20,
        }),
      },
    });

    const settings = await service.getScheduleSettings();
    assert.equal(settings.timezone, "America/Manaus");
    assert.equal(settings.min_interval_min, 5);
    assert.equal(settings.max_interval_min, 20);

    const defaultsService = createSettingsService({
      settingsRepository: { getSettings: async () => null },
    });

    const defaults = await defaultsService.getScheduleSettings();
    assert.equal(defaults.timezone, "America/Sao_Paulo");
    assert.equal(defaults.min_interval_min, 4);
    assert.equal(defaults.max_interval_min, 12);
  }

  // ---------- updateScheduleSettings ----------
  {
    const updateCalls = [];
    let storedSettings = {
      default_timezone: "America/Sao_Paulo",
      default_min_interval_min: 4,
      default_max_interval_min: 12,
    };
    const settingsRepository = {
      getSettings: async () => storedSettings,
      updateSettings: async (payload) => {
        updateCalls.push(payload);
        storedSettings = { ...storedSettings, ...payload };
        return storedSettings;
      },
    };

    const service = createSettingsService({ settingsRepository });

    const updated = await service.updateScheduleSettings({
      timezone: "America/Manaus",
      min_interval_min: 6,
      max_interval_min: 18,
    });

    assert.equal(updateCalls[0].default_timezone, "America/Manaus");
    assert.equal(updateCalls[0].default_min_interval_min, 6);
    assert.equal(updateCalls[0].default_max_interval_min, 18);
    assert.equal(updated.timezone, "America/Manaus");

    await assert.rejects(
      () => service.updateScheduleSettings({ timezone: "", min_interval_min: 4, max_interval_min: 12 }),
      /timezone is required/
    );
    await assert.rejects(
      () => service.updateScheduleSettings({ timezone: "Not/AZone", min_interval_min: 4, max_interval_min: 12 }),
      /timezone is invalid/
    );
    await assert.rejects(
      () => service.updateScheduleSettings({ timezone: "UTC", min_interval_min: 0, max_interval_min: 12 }),
      /min_interval_min must be an integer/
    );
    await assert.rejects(
      () => service.updateScheduleSettings({ timezone: "UTC", min_interval_min: 10, max_interval_min: 5 }),
      /max_interval_min must be an integer greater than or equal to min_interval_min/
    );
  }

  // ---------- getNotificationSettings ----------
  {
    const service = createSettingsService({
      settingsRepository: {
        getSettings: async () => ({
          notification_group_id: "group-1",
          notification_events: { campaignStarted: false },
        }),
      },
      groupsRepository: {
        findById: async (id) => {
          assert.equal(id, "group-1");
          return { id, nome: "Equipe Estimulo" };
        },
      },
    });

    const settings = await service.getNotificationSettings();
    assert.equal(settings.notification_group_id, "group-1");
    assert.equal(settings.notification_group_name, "Equipe Estimulo");
    assert.equal(settings.events.campaignStarted, false);
    assert.equal(settings.events.campaignFinished, true);
    assert.equal(settings.events.dispatchFailure, true);
    assert.equal(settings.events.aiError, true);

    const noGroupService = createSettingsService({
      settingsRepository: { getSettings: async () => ({}) },
      groupsRepository: { findById: async () => { throw new Error("should not be called"); } },
    });

    const noGroupSettings = await noGroupService.getNotificationSettings();
    assert.equal(noGroupSettings.notification_group_id, null);
    assert.equal(noGroupSettings.notification_group_name, null);
    assert.deepEqual(noGroupSettings.events, {
      campaignStarted: true,
      campaignFinished: true,
      dispatchFailure: true,
      aiError: true,
      trailFinished: true,
    });
  }

  // ---------- updateNotificationSettings ----------
  {
    let storedSettings = {};
    const settingsRepository = {
      getSettings: async () => storedSettings,
      updateSettings: async (payload) => {
        storedSettings = { ...storedSettings, ...payload };
        return storedSettings;
      },
    };
    const groupsRepository = {
      findById: async (id) => (id === "group-1" ? { id, nome: "Equipe Estimulo" } : null),
    };

    const service = createSettingsService({ settingsRepository, groupsRepository });

    const updated = await service.updateNotificationSettings({ notification_group_id: "group-1" });
    assert.equal(updated.notification_group_id, "group-1");
    assert.equal(updated.notification_group_name, "Equipe Estimulo");

    await assert.rejects(
      () => service.updateNotificationSettings({ notification_group_id: "missing-group" }),
      /Group not found/
    );

    await assert.rejects(
      () => service.updateNotificationSettings({ notification_group_id: 123 }),
      /notification_group_id must be a string or null/
    );

    const cleared = await service.updateNotificationSettings({ notification_group_id: null });
    assert.equal(cleared.notification_group_id, null);

    // merge parcial de events preserva os demais campos
    await service.updateNotificationSettings({ events: { dispatchFailure: false } });
    const afterPartialUpdate = await service.getNotificationSettings();
    assert.equal(afterPartialUpdate.events.dispatchFailure, false);
    assert.equal(afterPartialUpdate.events.campaignStarted, true);
    assert.equal(afterPartialUpdate.events.campaignFinished, true);
    assert.equal(afterPartialUpdate.events.aiError, true);
  }

  // ---------- getAIAgentsSettings ----------
  {
    const service = createSettingsService({
      settingsRepository: {
        getSettings: async () => ({
          ai_agents: {
            transcription: { models: ["gemini-2.5-pro"] },
            caption_generation: { models: ["gemini-3.5-flash"], prompt: "Prompt customizado" },
          },
        }),
      },
    });

    const settings = await service.getAIAgentsSettings();
    assert.deepEqual(settings.transcription.models, ["gemini-2.5-pro"]);
    assert.equal(settings.transcription.prompt, null);
    assert.deepEqual(settings.caption_generation.models, ["gemini-3.5-flash"]);
    assert.equal(settings.caption_generation.prompt, "Prompt customizado");
    // caption_review nao configurado -> cai no default
    assert.deepEqual(settings.caption_review.models, [
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
      "gemini-flash-lite-latest",
    ]);
    assert.equal(settings.caption_review.prompt, null);
    // default_prompt sempre exposto (texto do sistema) para a UI mostrar antes de customizar,
    // independente de haver ou nao um prompt customizado salvo
    assert.ok(settings.caption_generation.default_prompt.includes("Copywriter"));
    assert.ok(settings.caption_review.default_prompt.includes("revisao factual"));

    const defaultsService = createSettingsService({
      settingsRepository: { getSettings: async () => ({}) },
    });

    const defaults = await defaultsService.getAIAgentsSettings();
    assert.deepEqual(defaults.transcription.models, [
      "gemini-3.5-flash",
      "gemini-3.1-flash-lite",
      "gemini-flash-latest",
    ]);
  }

  // ---------- updateAIAgentsSettings ----------
  {
    const updateCalls = [];
    let storedSettings = {};
    const settingsRepository = {
      getSettings: async () => storedSettings,
      updateSettings: async (payload) => {
        updateCalls.push(payload);
        storedSettings = { ...storedSettings, ...payload };
        return storedSettings;
      },
    };

    const service = createSettingsService({ settingsRepository });

    const updated = await service.updateAIAgentsSettings({
      transcription: { models: ["gemini-2.5-pro", "gemini-3.5-flash"] },
      caption_generation: { models: ["gemini-3.5-flash"], prompt: "Novo prompt" },
    });

    assert.deepEqual(updated.transcription.models, ["gemini-2.5-pro", "gemini-3.5-flash"]);
    assert.deepEqual(updated.caption_generation.models, ["gemini-3.5-flash"]);
    assert.equal(updated.caption_generation.prompt, "Novo prompt");
    // caption_review nao foi enviado no payload -> permanece com o default
    assert.deepEqual(updated.caption_review.models, [
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
      "gemini-flash-lite-latest",
    ]);

    await assert.rejects(
      () => service.updateAIAgentsSettings({ transcription: { models: [] } }),
      /transcription\.models must be a non-empty array/
    );
    await assert.rejects(
      () => service.updateAIAgentsSettings({ transcription: { models: ["gemini-1.0-unknown"] } }),
      /transcription\.models contains an unsupported model/
    );
    await assert.rejects(
      () => service.updateAIAgentsSettings({ caption_review: { models: ["gemini-3.5-flash"], prompt: 123 } }),
      /caption_review\.prompt must be a string or null/
    );

    // prompt: null explicito limpa o prompt customizado (volta ao default do sistema)
    const cleared = await service.updateAIAgentsSettings({
      caption_generation: { models: ["gemini-3.5-flash"], prompt: null },
    });
    assert.equal(cleared.caption_generation.prompt, null);

    // Modelos retirados pelo Google (404 "no longer available") nao podem mais ser
    // salvos: era exatamente essa configuracao que derrubava o envio das campanhas.
    await assert.rejects(
      () => service.updateAIAgentsSettings({ caption_review: { models: ["gemini-2.5-flash-lite"] } }),
      /caption_review\.models contains an unsupported model/
    );
  }

  console.log("settings service tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
