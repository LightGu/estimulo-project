function createReportController(dependencies = {}) {
  const dispatchLogsService = dependencies.dispatchLogsService;

  async function listDispatches(req, res) {
    try {
      const { start_date, end_date, organization_id, group_id, status } = req.query;

      const logs = await dispatchLogsService.listForReport({
        startDate: start_date || null,
        endDate: end_date || null,
        organizationId: organization_id || null,
        groupId: group_id || null,
        status: status || null,
      });

      return res.status(200).json(logs);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (
        ["Start date cannot be in the future", "End date cannot be in the future", "Start date cannot be after end date"].includes(
          message
        )
      ) {
        return res.status(400).json({ error: message });
      }

      console.error(
        JSON.stringify({
          event: "reports.dispatches.failed",
          error_message: message,
        })
      );

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  return {
    listDispatches,
  };
}

module.exports = createReportController;
