function createGroupsController(dependencies = {}) {
  const groupService = dependencies.groupService;

  async function syncFromEvolution(req, res) {
    try {
      const result = await groupService.syncGroupsFromEvolution(req.body || {});

      return res.status(200).json(result);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (
        [
          "Organization id is required",
          "Segmento is required",
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

  return {
    syncFromEvolution,
  };
}

module.exports = createGroupsController;
