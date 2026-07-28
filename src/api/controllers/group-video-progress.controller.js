function createGroupVideoProgressController(dependencies = {}) {
  const groupVideoProgressService = dependencies.groupVideoProgressService;
  const groupService = dependencies.groupService;

  async function getGroupProgress(req, res) {
    try {
      const groupId = req.params.id;
      const group = await groupService.getById(groupId);

      if (!group) {
        return res.status(404).json({ error: "Group not found" });
      }

      const summary = await groupVideoProgressService.getGroupProgressSummary(groupId, group);

      return res.status(200).json(summary);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "Group id is required") {
        return res.status(400).json({ error: message });
      }

      if (message === "Group not found") {
        return res.status(404).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  return {
    getGroupProgress,
  };
}

module.exports = createGroupVideoProgressController;
