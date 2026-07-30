function createSettingsController(dependencies = {}) {
  const settingsService = dependencies.settingsService;

  async function getDriveSettings(req, res) {
    try {
      const settings = await settingsService.getDriveSettings();
      const connection = await settingsService.testDriveConnection();

      return res.status(200).json({ ...settings, ...connection });
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function updateDriveRootFolder(req, res) {
    try {
      const settings = await settingsService.updateDriveRootFolder(req.body || {});

      return res.status(200).json(settings);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "folder_url_or_id is required" || message.startsWith("Nao foi possivel extrair")) {
        return res.status(400).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function updateDriveSchedule(req, res) {
    try {
      const settings = await settingsService.updateDriveIndexSchedule(req.body || {});

      return res.status(200).json(settings);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (
        ["hour must be an integer between 0 and 23", "minute must be an integer between 0 and 59"].includes(message)
      ) {
        return res.status(400).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function getScheduleSettings(req, res) {
    try {
      const settings = await settingsService.getScheduleSettings();

      return res.status(200).json(settings);
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function updateScheduleSettings(req, res) {
    try {
      const settings = await settingsService.updateScheduleSettings(req.body || {});

      return res.status(200).json(settings);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (
        [
          "timezone is required",
          "timezone is invalid",
          "min_interval_min must be an integer greater than or equal to 1",
          "max_interval_min must be an integer greater than or equal to min_interval_min",
          "dispatch_periods entries must have valid inicio/fim times (HH:mm)",
          "dispatch_periods entries must have inicio earlier than fim",
        ].includes(message)
      ) {
        return res.status(400).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function getNotificationSettings(req, res) {
    try {
      const settings = await settingsService.getNotificationSettings();

      return res.status(200).json(settings);
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function updateNotificationSettings(req, res) {
    try {
      const settings = await settingsService.updateNotificationSettings(req.body || {});

      return res.status(200).json(settings);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (["notification_group_id must be a string or null", "Group not found"].includes(message)) {
        return res.status(400).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function getProfileSettings(req, res) {
    try {
      const settings = await settingsService.getProfileSettings();

      return res.status(200).json(settings);
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function updateProfileSettings(req, res) {
    try {
      const settings = await settingsService.updateProfileSettings(req.body || {});

      return res.status(200).json(settings);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "profile_name is required") {
        return res.status(400).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function getAIAgentsSettings(req, res) {
    try {
      const settings = await settingsService.getAIAgentsSettings();

      return res.status(200).json(settings);
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function updateAIAgentsSettings(req, res) {
    try {
      const settings = await settingsService.updateAIAgentsSettings(req.body || {});

      return res.status(200).json(settings);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (
        /\.models must be a non-empty array$/.test(message) ||
        /\.models contains an unsupported model: /.test(message) ||
        /\.prompt must be a string or null$/.test(message)
      ) {
        return res.status(400).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function getDispatchRulesSettings(req, res) {
    try {
      const settings = await settingsService.getDispatchRulesSettings();

      return res.status(200).json(settings);
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function updateDispatchRulesSettings(req, res) {
    try {
      const settings = await settingsService.updateDispatchRulesSettings(req.body || {});

      return res.status(200).json(settings);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (
        /must be a boolean$/.test(message) ||
        /^auto_send_after_timeout must be an object$/.test(message) ||
        /^auto_send_after_timeout\.minutes must be an integer/.test(message)
      ) {
        return res.status(400).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function testConnection(req, res) {
    try {
      const result = await settingsService.testDriveConnection();

      return res.status(200).json(result);
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function testDatabaseConnection(req, res) {
    try {
      const result = await settingsService.testDatabaseConnection();

      return res.status(200).json(result);
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function reindexNow(req, res) {
    try {
      const result = await settingsService.reindexDriveNow();

      return res.status(200).json(result);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "Drive root folder is not configured") {
        return res.status(400).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  return {
    getAIAgentsSettings,
    getDispatchRulesSettings,
    getDriveSettings,
    getNotificationSettings,
    getProfileSettings,
    getScheduleSettings,
    reindexNow,
    testConnection,
    testDatabaseConnection,
    updateAIAgentsSettings,
    updateDispatchRulesSettings,
    updateDriveRootFolder,
    updateDriveSchedule,
    updateNotificationSettings,
    updateProfileSettings,
    updateScheduleSettings,
  };
}

module.exports = createSettingsController;
