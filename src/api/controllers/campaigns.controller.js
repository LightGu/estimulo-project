function createCampaignsController(dependencies = {}) {
  const campaignService = dependencies.campaignService;

  async function create(req, res) {
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
  }

  async function list(req, res) {
    try {
      const campaigns = await campaignService.listWithSummary();

      return res.status(200).json(campaigns);
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function getById(req, res) {
    try {
      const campaign = await campaignService.getById(req.params.id);

      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      return res.status(200).json(campaign);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "Campaign id is required") {
        return res.status(400).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function listGroups(req, res) {
    try {
      const groups = await campaignService.getGroupsDetail(req.params.id);

      return res.status(200).json(groups);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "Campaign id is required") {
        return res.status(400).json({ error: message });
      }

      if (message === "Campaign not found") {
        return res.status(404).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function dispatch(req, res) {
    try {
      const result = await campaignService.dispatchCampaign(req.body || {});

      return res.status(202).json(result);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (
        ["At least one group id is required", "Group id is required", "Execution date is invalid"].includes(message)
      ) {
        return res.status(400).json({ error: message });
      }

      if (message === "Group not found") {
        return res.status(404).json({ error: message });
      }

      console.error(
        JSON.stringify({
          event: "campaigns.dispatch.failed",
          error_message: message,
        })
      );

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function confirmDispatch(req, res) {
    try {
      console.log(
        JSON.stringify({
          event: "campaigns.confirm_dispatch.started",
          campaign_id: req.params.id,
        })
      );

      const result = await campaignService.confirmDispatch(req.params.id, req.body || {});

      console.log(
        JSON.stringify({
          event: "campaigns.confirm_dispatch.completed",
          campaign_id: req.params.id,
          pending_logs_created: result?.pending_logs?.pending_logs_created,
        })
      );

      return res.status(200).json(result);
    } catch (error) {
      const message = error?.message || "Internal server error";

      console.error(
        JSON.stringify({
          event: "campaigns.confirm_dispatch.failed",
          campaign_id: req.params.id,
          error_message: message,
        })
      );

      if (error?.code === "CAPTIONS_PENDING") {
        return res.status(409).json({ error: message });
      }

      if (message === "Execution date is invalid") {
        return res.status(400).json({ error: message });
      }

      if (message === "Campaign not found") {
        return res.status(404).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  return {
    confirmDispatch,
    create,
    dispatch,
    getById,
    list,
    listGroups,
  };
}

module.exports = createCampaignsController;
