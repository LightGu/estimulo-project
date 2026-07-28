function createOrganizationsController(dependencies = {}) {
  const organizationService = dependencies.organizationService;

  async function list(req, res) {
    try {
      const organizations = await organizationService.list();

      return res.status(200).json(organizations);
    } catch (error) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function create(req, res) {
    try {
      const organization = await organizationService.create(req.body || {});

      return res.status(201).json(organization);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (
        [
          "Organization name is required",
          "Organization already exists",
          "Descricao must be a string or null",
          "Programa must be a string or null",
        ].includes(message)
      ) {
        return res.status(400).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async function update(req, res) {
    try {
      const organization = await organizationService.update(req.params.id, req.body || {});

      return res.status(200).json(organization);
    } catch (error) {
      const message = error?.message || "Internal server error";

      if (
        [
          "Organization id is required",
          "At least one field is required",
          "Organization name is required",
          "Descricao must be a string or null",
          "Programa must be a string or null",
        ].includes(message)
      ) {
        return res.status(400).json({ error: message });
      }

      if (message === "Organization not found") {
        return res.status(404).json({ error: message });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }

  return {
    create,
    list,
    update,
  };
}

module.exports = createOrganizationsController;
