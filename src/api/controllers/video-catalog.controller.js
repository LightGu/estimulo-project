function createVideoCatalogController(dependencies = {}) {
  const videoCatalogService = dependencies.videoCatalogService;

  async function listTrailsByProfile(req, res) {
    try {
      const profile = req.query.perfil || req.query.profile || req.query.segmento;
      const trails = await videoCatalogService.listTrailsByProfile(profile);

      return res.status(200).json(trails);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "Profile is required") {
        return res.status(400).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  return {
    listTrailsByProfile,
  };
}

module.exports = createVideoCatalogController;
