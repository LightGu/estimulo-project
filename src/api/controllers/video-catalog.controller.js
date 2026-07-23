function createVideoCatalogController(dependencies = {}) {
  const videoCatalogService = dependencies.videoCatalogService;

  function resolveForce(req) {
    return req.body?.force ?? req.query?.force;
  }

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

  async function listTrailsOverview(req, res) {
    try {
      const trails = await videoCatalogService.listTrailsOverview();

      return res.status(200).json(trails);
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function listUnclassified(req, res) {
    try {
      const videos = await videoCatalogService.listUnclassified();

      return res.status(200).json(videos);
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function createTrailVideos(req, res) {
    try {
      const videos = await videoCatalogService.createTrailVideos(req.body || {});

      return res.status(201).json(videos);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (
        [
          "Perfil da jornada is required",
          "Macrotema is required",
          "Trilha is required",
          "At least one video_id is required",
        ].includes(message)
      ) {
        return res.status(400).json({ error: message });
      }

      if (message === "Video not found") {
        return res.status(404).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function moveVideoTrail(req, res) {
    try {
      const video = await videoCatalogService.moveVideoTrail(req.params.id, req.body || {});

      return res.status(200).json(video);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (
        [
          "Video id is required",
          "Perfil da jornada is required",
          "Macrotema is required",
          "Trilha is required",
        ].includes(message)
      ) {
        return res.status(400).json({ error: message });
      }

      if (message === "Video not found") {
        return res.status(404).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function reorderTrailVideos(req, res) {
    try {
      const videos = await videoCatalogService.reorderTrailVideos(req.body?.ordered_ids);

      return res.status(200).json(videos);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "orderedIds is required") {
        return res.status(400).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function transcribeByDriveFileId(req, res) {
    try {
      const driveFileId = req.body?.drive_file_id || req.body?.driveFileId || req.query?.drive_file_id;
      const result = await videoCatalogService.transcribeByDriveFileId(driveFileId, { force: resolveForce(req) });

      return res.status(result.skipped ? 200 : 201).json(result);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (
        [
          "Drive file id is required",
          "Registro video_catalog nao encontrado",
          "drive_file_id e obrigatorio para transcrever video",
        ].includes(message)
      ) {
        return res.status(400).json({ error: message });
      }

      return res.status(500).json({ error: message });
    }
  }

  async function transcribeById(req, res) {
    try {
      const result = await videoCatalogService.transcribeById(req.params.id, { force: resolveForce(req) });

      return res.status(result.skipped ? 200 : 201).json(result);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (
        [
          "Video id is required",
          "Registro video_catalog nao encontrado",
          "drive_file_id e obrigatorio para transcrever video",
        ].includes(message)
      ) {
        return res.status(400).json({ error: message });
      }

      return res.status(500).json({ error: message });
    }
  }

  return {
    listTrailsByProfile,
    listTrailsOverview,
    listUnclassified,
    createTrailVideos,
    moveVideoTrail,
    reorderTrailVideos,
    transcribeByDriveFileId,
    transcribeById,
  };
}

module.exports = createVideoCatalogController;
