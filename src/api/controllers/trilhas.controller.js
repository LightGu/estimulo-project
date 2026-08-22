function createTrilhasController(dependencies = {}) {
  const trilhasService = dependencies.trilhasService;
  const trilhaSequenceService = dependencies.trilhaSequenceService;

  async function listAll(req, res) {
    try {
      const trilhas = await trilhasService.listAll();

      return res.status(200).json(trilhas);
    } catch (error) {
      return handleError(error, res);
    }
  }

  async function listOverview(req, res) {
    try {
      const trilhas = await trilhasService.listOverview();

      return res.status(200).json(trilhas);
    } catch (error) {
      return handleError(error, res);
    }
  }

  async function listByPerfil(req, res) {
    try {
      const trilhas = req.query?.profile_id
        ? await trilhasService.listByProfileId(req.query.profile_id)
        : await trilhasService.listByPerfil(req.query?.perfil);

      return res.status(200).json(trilhas);
    } catch (error) {
      return handleError(error, res);
    }
  }

  async function listSequence(req, res) {
    try {
      const sequence = await trilhasService.listSequenceForProfile(req.query?.profile_id);

      return res.status(200).json(sequence);
    } catch (error) {
      return handleError(error, res);
    }
  }

  async function addTrilhaToSequence(req, res) {
    try {
      const entry = await trilhasService.addTrilhaToSequence(
        req.body?.profile_id,
        req.body?.trilha_id,
        req.body?.after_trilha_id
      );

      return res.status(201).json(entry);
    } catch (error) {
      return handleError(error, res);
    }
  }

  async function reorderSequence(req, res) {
    try {
      const sequence = await trilhasService.reorderSequenceForProfile(
        req.body?.profile_id,
        req.body?.ordered_trilha_ids
      );

      return res.status(200).json(sequence);
    } catch (error) {
      return handleError(error, res);
    }
  }

  async function removeFromSequence(req, res) {
    try {
      const sequence = await trilhasService.removeTrilhaFromSequence(
        req.query?.profile_id,
        req.params?.trilhaId
      );

      return res.status(200).json(sequence);
    } catch (error) {
      return handleError(error, res);
    }
  }

  async function listDesvios(req, res) {
    try {
      const desvios = await trilhaSequenceService.listDesviosByProfile(req.query?.profile_id);

      return res.status(200).json(desvios);
    } catch (error) {
      return handleDesvioError(error, res);
    }
  }

  async function createDesvio(req, res) {
    try {
      const desvio = await trilhaSequenceService.createDesvio(req.body || {});

      return res.status(201).json(desvio);
    } catch (error) {
      return handleDesvioError(error, res);
    }
  }

  async function removeDesvio(req, res) {
    try {
      const desvio = await trilhaSequenceService.removeDesvio(req.params.id);

      return res.status(200).json(desvio);
    } catch (error) {
      return handleDesvioError(error, res);
    }
  }

  function handleDesvioError(error, res) {
    const message = error?.message || "Internal server error";

    const badRequestMessages = [
      "Profile id is required",
      "After trilha id is required",
      "Trilha destino id is required",
      "At least one setor is required",
      "Desvio id is required",
      "Setor already has a desvio at this point in the sequence",
    ];

    if (badRequestMessages.includes(message)) {
      return res.status(400).json({ error: message });
    }

    if (["Profile not found", "After trilha not found", "Trilha destino not found", "Desvio not found"].includes(message)) {
      return res.status(404).json({ error: message });
    }

    return res.status(500).json({ error: "Internal server error" });
  }

  async function listSelectableVideos(req, res) {
    try {
      const videos = await trilhasService.listSelectableVideos();

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

  async function getTrilhaUsage(req, res) {
    try {
      const usage = await trilhasService.getTrilhaUsage(req.params.id);

      return res.status(200).json(usage);
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
      "Trilha id is required",
      "Video id is required",
      "Destination trilha id is required",
      "Macrotema is required",
      "Trilha is required",
      "At least one video_id is required",
      "At least one perfil is required",
      "Profile id is required",
      "At least one field is required",
      "orderedVideoIds is required",
      "orderedTrilhaIds is required",
      "orderedTrilhaIds must include every trilha currently in this profile's sequence",
      "Trilha is not part of this profile's sequence",
      "Trilha already exists",
      "Video already in trilha",
      "Video not in trilha",
      "Trilha already in this profile's sequence",
    ];

    if (badRequestMessages.includes(message) || message.startsWith("Invalid perfil:")) {
      return res.status(400).json({ error: message });
    }

    if (["Trilha not found", "Video not found", "Profile not found"].includes(message)) {
      return res.status(404).json({ error: message });
    }

    return res.status(500).json({ error: "Internal server error" });
  }

  return {
    listAll,
    listOverview,
    listByPerfil,
    listSequence,
    addTrilhaToSequence,
    reorderSequence,
    removeFromSequence,
    listDesvios,
    createDesvio,
    removeDesvio,
    listSelectableVideos,
    createTrilha,
    renameTrilha,
    removeTrilha,
    getTrilhaUsage,
    updateTrailPerfis,
    addVideoToTrilha,
    removeVideoFromTrilha,
    moveVideoBetweenTrilhas,
    reorderTrilhaVideos,
  };
}

module.exports = createTrilhasController;
