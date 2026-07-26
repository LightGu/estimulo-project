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

  return {
    getProgress,
    updateCaption,
  };
}

module.exports = createCampaignVideoCaptionsController;
