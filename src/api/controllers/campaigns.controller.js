function createCampaignsController(dependencies = {}) {
  const campaignService = dependencies.campaignService;

  return async function createCampaign(req, res) {
    try {
      const campaign = await campaignService.create(req.body || {});

      return res.status(201).json(campaign);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (
        [
          "Campaign name is required",
          "Organization id is required",
          "Cron expression is required",
        ].includes(message)
      ) {
        return res.status(400).json({ error: message });
      }

      if (message === "Organization not found") {
        return res.status(404).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  };
}

module.exports = createCampaignsController;
