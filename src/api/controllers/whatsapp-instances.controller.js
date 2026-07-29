function createWhatsappInstancesController(dependencies = {}) {
  const service = dependencies.whatsappInstancesService;

  async function list(req, res) {
    try {
      const instances = await service.list();

      return res.status(200).json(instances);
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function register(req, res) {
    try {
      const instance = await service.registerInstance(req.body || {});

      return res.status(201).json(instance);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "instance_name is required") {
        return res.status(400).json({ error: message });
      }

      if (message === "Instance already exists") {
        return res.status(409).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function getQrCode(req, res) {
    try {
      const result = await service.generateQrCode(req.params.id);

      return res.status(200).json(result);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "Instance not found") {
        return res.status(404).json({ error: message });
      }

      if (message === "Evolution API did not return a QR code") {
        return res.status(502).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function getStatus(req, res) {
    try {
      const instance = await service.checkConnectionStatus(req.params.id);

      return res.status(200).json(instance);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "Instance not found") {
        return res.status(404).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function remove(req, res) {
    try {
      const result = await service.removeInstance(req.params.id);

      return res.status(200).json(result);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "Instance not found") {
        return res.status(404).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function reorder(req, res) {
    try {
      const result = await service.reorderPriority((req.body || {}).ordered_ids || []);

      return res.status(200).json(result);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message === "orderedIds must be a non-empty array") {
        return res.status(400).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function testConnection(req, res) {
    try {
      const result = await service.testConnection();

      return res.status(200).json(result);
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function getRotation(req, res) {
    try {
      const result = await service.getRotationSettings();

      return res.status(200).json(result);
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function updateRotation(req, res) {
    try {
      const result = await service.updateRotationSettings(req.body || {});

      return res.status(200).json(result);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (message.startsWith("whatsapp_rotation_group_count")) {
        return res.status(400).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  return {
    getQrCode,
    getRotation,
    getStatus,
    list,
    register,
    remove,
    reorder,
    testConnection,
    updateRotation,
  };
}

module.exports = createWhatsappInstancesController;
