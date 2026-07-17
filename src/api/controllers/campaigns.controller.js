function createCampaignsController(dependencies = {}) {
  const campaignService = dependencies.campaignService;

  return async function createCampaign(req, res) {
    try {
      const payload = req.body || {};
      const hasGroups = payload.group_id || (Array.isArray(payload.group_ids) && payload.group_ids.length > 0);
      const campaign = hasGroups && typeof campaignService.createAndQueue === "function"
        ? await campaignService.createAndQueue(payload)
        : await campaignService.create(payload);

      return res.status(201).json(campaign);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (
        [
          "Campaign name is required",
          "Campaign trail is required",
          "Organization id is required",
          "At least one group id is required",
          "Group id is required",
          "Execution date is invalid",
          "Group does not belong to organization",
        ].includes(message)
      ) {
        return res.status(400).json({ error: message });
      }

      if (["Organization not found", "Group not found"].includes(message)) {
        return res.status(404).json({ error: message });
      }

      console.error(
        JSON.stringify({
          event: "campaigns.create.failed",
          error_message: message,
        })
      );

      return res.status(500).json({ error: "Internal server error" });
    }
  };
}

module.exports = createCampaignsController;
