function createCampaignVideoCaptionsController(dependencies = {}) {
  const campaignVideoCaptionsService = dependencies.campaignVideoCaptionsService;

  async function getProgress(req, res) {
    try {
      const progress = await campaignVideoCaptionsService.getCaptionProgress(req.params.id);

      return res.status(200).json(progress);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "Campaign id is required") {
        return res.status(400).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function updateCaption(req, res) {
    try {
      const captionText = req.body && req.body.caption_text;
      const updated = await campaignVideoCaptionsService.updateCaptionText(req.params.captionRowId, captionText);

      return res.status(200).json(updated);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (
        ["Campaign video caption id is required", "Caption text is required"].includes(message)
      ) {
        return res.status(400).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function regenerateCaption(req, res) {
    try {
      const updated = await campaignVideoCaptionsService.regenerateCaption(req.params.captionRowId);

      return res.status(200).json(updated);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "Campaign video caption id is required") {
        return res.status(400).json({ error: message });
      }

      if (message === "Campaign video caption not found") {
        return res.status(404).json({ error: message });
      }

      console.error(
        JSON.stringify({
          event: "campaign_video_captions.regenerate.failed",
          caption_row_id: req.params.captionRowId,
          error_message: message,
        })
      );

      return res.status(422).json({ error: `Falha ao gerar legenda: ${message}` });
    }
  }

  return {
    getProgress,
    regenerateCaption,
    updateCaption,
  };
}

module.exports = createCampaignVideoCaptionsController;
