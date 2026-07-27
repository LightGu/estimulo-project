function createTrilhasController(dependencies = {}) {
  const trilhasService = dependencies.trilhasService;

  function resolveOrganizationId(req) {
    return req.query?.organization_id;
  }

  async function listByOrganization(req, res) {
    try {
      const trilhas = await trilhasService.listByOrganization(resolveOrganizationId(req));

      return res.status(200).json(trilhas);
    } catch (error) {
      return handleError(error, res);
    }
  }

  async function listOverview(req, res) {
    try {
      const trilhas = await trilhasService.listOverview(resolveOrganizationId(req));

      return res.status(200).json(trilhas);
    } catch (error) {
      return handleError(error, res);
    }
  }

  async function listSelectableVideos(req, res) {
    try {
      const videos = await trilhasService.listSelectableVideos(resolveOrganizationId(req));

      return res.status(200).json(videos);
    } catch (error) {
      return handleError(error, res);
    }
  }

  async function createTrilha(req, res) {
    try {
      const trilha = await trilhasService.createTrilha(req.body || {});

      return res.status(201).json(trilha);
    } catch (error) {
      return handleError(error, res);
    }
  }

  async function renameTrilha(req, res) {
    try {
      const trilha = await trilhasService.renameTrilha(req.params.id, req.body || {});

      return res.status(200).json(trilha);
    } catch (error) {
      return handleError(error, res);
    }
  }

  async function removeTrilha(req, res) {
    try {
      const trilha = await trilhasService.removeTrilha(req.params.id);

      return res.status(200).json(trilha);
    } catch (error) {
      return handleError(error, res);
    }
  }

  async function updateTrailPerfis(req, res) {
    try {
      const perfis = await trilhasService.updateTrailPerfis(req.params.id, req.body?.perfis);

      return res.status(200).json({ id: req.params.id, perfis });
    } catch (error) {
      return handleError(error, res);
    }
  }

  async function addVideoToTrilha(req, res) {
    try {
      const link = await trilhasService.addVideoToTrilha(req.params.id, req.body?.video_id);

      return res.status(201).json(link);
    } catch (error) {
      return handleError(error, res);
    }
  }

  async function removeVideoFromTrilha(req, res) {
    try {
      const link = await trilhasService.removeVideoFromTrilha(req.params.id, req.params.videoId);

      return res.status(200).json(link);
    } catch (error) {
      return handleError(error, res);
    }
  }

  async function moveVideoBetweenTrilhas(req, res) {
    try {
      const link = await trilhasService.moveVideoBetweenTrilhas(req.params.videoId, {
        from_trilha_id: req.params.id,
        to_trilha_id: req.body?.to_trilha_id,
      });

      return res.status(200).json(link);
    } catch (error) {
      return handleError(error, res);
    }
  }

  async function reorderTrilhaVideos(req, res) {
    try {
      const links = await trilhasService.reorderTrilhaVideos(req.params.id, req.body?.ordered_video_ids);

      return res.status(200).json(links);
    } catch (error) {
      return handleError(error, res);
    }
  }

  function handleError(error, res) {
    const message = error?.message || "Internal server error";

    const badRequestMessages = [
      "Organization id is required",
      "Trilha id is required",
      "Video id is required",
      "Destination trilha id is required",
      "Macrotema is required",
      "Trilha is required",
      "At least one video_id is required",
      "At least one perfil is required",
      "At least one field is required",
      "orderedVideoIds is required",
      "Trilha already exists",
      "Video already in trilha",
      "Video not in trilha",
      "Trilhas must belong to the same organization",
    ];

    if (badRequestMessages.includes(message) || message.startsWith("Invalid perfil:")) {
      return res.status(400).json({ error: message });
    }

    if (["Organization not found", "Trilha not found", "Video not found"].includes(message)) {
      return res.status(404).json({ error: message });
    }

    return res.status(500).json({ error: "Internal server error" });
  }

  return {
    listByOrganization,
    listOverview,
    listSelectableVideos,
    createTrilha,
    renameTrilha,
    removeTrilha,
    updateTrailPerfis,
    addVideoToTrilha,
    removeVideoFromTrilha,
    moveVideoBetweenTrilhas,
    reorderTrilhaVideos,
  };
}

module.exports = createTrilhasController;
