const campaignsRepository = require("../repositories/campaigns.repository");
const organizationsRepository = require("../repositories/organizations.repository");

function createCampaignsService(dependencies = {}) {
  const repository = dependencies.repository || campaignsRepository;
  const organizationRepository = dependencies.organizationRepository || organizationsRepository;

  async function create(payload) {
    const nome = payload?.nome?.trim();
    const organizationId = payload?.organization_id;
    const cronExpression = payload?.cron_expression?.trim();

    if (!nome) {
      throw new Error("Campaign name is required");
    }

    if (!organizationId) {
      throw new Error("Organization id is required");
    }

    if (!cronExpression) {
      throw new Error("Cron expression is required");
    }

    const organization = await organizationRepository.findById(organizationId);

    if (!organization) {
      throw new Error("Organization not found");
    }

    return repository.create({ ...payload, nome, cron_expression: cronExpression });
  }

  async function update(id, payload) {
    if (!id) {
      throw new Error("Campaign id is required");
    }

    if (!payload || Object.keys(payload).length === 0) {
      throw new Error("At least one field is required");
    }

    const current = await repository.findById(id);

    if (!current) {
      throw new Error("Campaign not found");
    }

    const nextPayload = { ...payload };

    if (nextPayload.nome !== undefined) {
      nextPayload.nome = nextPayload.nome.trim();

      if (!nextPayload.nome) {
        throw new Error("Campaign name is required");
      }
    }

    if (nextPayload.cron_expression !== undefined) {
      nextPayload.cron_expression = nextPayload.cron_expression.trim();

      if (!nextPayload.cron_expression) {
        throw new Error("Cron expression is required");
      }
    }

    return repository.update(id, nextPayload);
  }

  async function remove(id) {
    if (!id) {
      throw new Error("Campaign id is required");
    }

    const current = await repository.findById(id);

    if (!current) {
      throw new Error("Campaign not found");
    }

    return repository.delete(id);
  }

  async function getById(id) {
    if (!id) {
      throw new Error("Campaign id is required");
    }

    return repository.findById(id);
  }

  async function list() {
    return repository.findAll();
  }

  async function listActive() {
    return repository.listActive();
  }

  async function listByOrganization(organizationId) {
    if (!organizationId) {
      throw new Error("Organization id is required");
    }

    return repository.listByOrganization(organizationId);
  }

  return {
    create,
    delete: remove,
    getById,
    list,
    listActive,
    listByOrganization,
    update,
  };
}

module.exports = createCampaignsService();
module.exports.createCampaignsService = createCampaignsService;
