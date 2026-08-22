function createVideoCatalogController(dependencies = {}) {
  const videoCatalogService = dependencies.videoCatalogService;
  const videoCaptionsService = dependencies.videoCaptionsService;

  function resolveForce(req) {
    return req.body?.force ?? req.query?.force;
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

  async function renameVideo(req, res) {
    try {
      const video = await videoCatalogService.renameVideo(req.params.id, req.body || {});

      return res.status(200).json(video);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (["Video id is required", "Nome do arquivo is required"].includes(message)) {
        return res.status(400).json({ error: message });
      }

      if (message === "Video not found") {
        return res.status(404).json({ error: message });
      }

      return res.status(500).json({ error: message });
    }
  }

  async function listCaptions(req, res) {
    try {
      const captions = await videoCaptionsService.listCaptionsByVideoId(req.params.id);

      return res.status(200).json(captions);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "Video id is required") {
        return res.status(400).json({ error: message });
      }

      if (message === "Video not found") {
        return res.status(404).json({ error: message });
      }

      return res.status(500).json({ error: message });
    }
  }

  async function updateCaption(req, res) {
    try {
      const caption = await videoCaptionsService.updateCaption(req.params.captionId, req.params.id, req.body || {});

      return res.status(200).json(caption);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (["Caption id is required", "Video id is required", "Caption text is required"].includes(message)) {
        return res.status(400).json({ error: message });
      }

      if (message === "Caption not found") {
        return res.status(404).json({ error: message });
      }

      return res.status(500).json({ error: message });
    }
  }

  return {
    listCaptions,
    renameVideo,
    transcribeByDriveFileId,
    transcribeById,
    updateCaption,
  };
}

module.exports = createVideoCatalogController;
