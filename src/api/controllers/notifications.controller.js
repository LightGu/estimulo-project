function createNotificationsController(dependencies = {}) {
  const notificationsService = dependencies.notificationsService;

  async function list(req, res) {
    try {
      const limit = Number(req.query.limit) || undefined;
      const result = await notificationsService.list({ limit });

      return res.status(200).json(result);
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function markAllRead(req, res) {
    try {
      const result = await notificationsService.markAllRead();

      return res.status(200).json(result);
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function markRead(req, res) {
    try {
      const notification = await notificationsService.markRead(req.params.id);

      return res.status(200).json(notification);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "Notification id is required") {
        return res.status(400).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  return {
    list,
    markAllRead,
    markRead,
  };
}

module.exports = createNotificationsController;
