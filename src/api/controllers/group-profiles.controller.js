function createGroupProfilesController(dependencies = {}) {
  const groupProfilesService = dependencies.groupProfilesService;

  async function list(req, res) {
    try {
      const profiles = await groupProfilesService.list();

      return res.status(200).json(profiles);
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function create(req, res) {
    try {
      const profile = await groupProfilesService.create(req.body || {});

      return res.status(201).json(profile);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (["Nome is required", "Profile already exists"].includes(message)) {
        return res.status(400).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function remove(req, res) {
    try {
      const profile = await groupProfilesService.remove(req.params.id);

      return res.status(200).json(profile);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "Profile not found") {
        return res.status(404).json({ error: message });
      }

      if (message === "Profile is in use and cannot be removed") {
        return res.status(409).json({ error: message });
      }

      if (message === "Profile id is required") {
        return res.status(400).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  return {
    create,
    list,
    remove,
  };
}

module.exports = createGroupProfilesController;
