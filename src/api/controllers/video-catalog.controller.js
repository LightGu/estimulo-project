function createVideoCatalogController(dependencies = {}) {
  const videoCatalogService = dependencies.videoCatalogService;

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

  return {
    transcribeByDriveFileId,
    transcribeById,
  };
}

module.exports = createVideoCatalogController;
