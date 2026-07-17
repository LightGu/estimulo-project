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

  return {
    list,
  };
}

module.exports = createOrganizationsController;
