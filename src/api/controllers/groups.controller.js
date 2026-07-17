function createGroupsController(dependencies = {}) {
  const groupService = dependencies.groupService;

  async function listWithoutSegment(req, res) {
    try {
      const groups = await groupService.listWithoutSegment();

      return res.status(200).json(groups);
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function syncFromEvolution(req, res) {
    try {
      const result = await groupService.syncGroupsFromEvolution(req.body || {});

      return res.status(200).json(result);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (
        [
          "Organization id is required",
          "Maturidade must be between 1 and 4",
        ].includes(message)
      ) {
        return res.status(400).json({ error: message });
      }

      if (message === "Organization not found") {
        return res.status(404).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function updateOperationalSettings(req, res) {
    try {
      const group = await groupService.updateOperationalSettings(req.params.id, req.body || {});

      return res.status(200).json(group);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (
        [
          "Group id is required",
          "At least one operational setting is required",
          "Segmento must be a string or null",
          "Trilha override must be a string or null",
          "Envia video must be boolean",
        ].includes(message)
      ) {
        return res.status(400).json({ error: message });
      }

      if (message === "Group not found") {
        return res.status(404).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  return {
    listWithoutSegment,
    syncFromEvolution,
    updateOperationalSettings,
  };
}

module.exports = createGroupsController;
