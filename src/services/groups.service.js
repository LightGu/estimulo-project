const groupsRepository = require("../repositories/groups.repository");
const organizationsRepository = require("../repositories/organizations.repository");

function createGroupsService(dependencies = {}) {
  const repository = dependencies.repository || groupsRepository;
  const organizationRepository = dependencies.organizationRepository || organizationsRepository;

  async function create(payload) {
    const nome = payload?.nome?.trim();
    const organizationId = payload?.organization_id;
    const evolutionGroupId = payload?.evolution_group_id?.trim();
    const maturidade = Number(payload?.maturidade);

    if (!nome) {
      throw new Error("Group name is required");
    }

    if (!organizationId) {
      throw new Error("Organization id is required");
    }

    if (!evolutionGroupId) {
      throw new Error("Evolution group id is required");
    }

    if (!Number.isInteger(maturidade) || maturidade < 1 || maturidade > 4) {
      throw new Error("Maturidade must be between 1 and 4");
    }

    const organization = await organizationRepository.findById(organizationId);

    if (!organization) {
      throw new Error("Organization not found");
    }

    const existingGroups = await repository.findAll();
    const duplicate = existingGroups.some((item) => item.evolution_group_id?.toLowerCase() === evolutionGroupId.toLowerCase());

    if (duplicate) {
      throw new Error("Group already exists");
    }

    return repository.create({ ...payload, nome, evolution_group_id: evolutionGroupId });
  }

  async function update(id, payload) {
    if (!id) {
      throw new Error("Group id is required");
    }

    if (!payload || Object.keys(payload).length === 0) {
      throw new Error("At least one field is required");
    }

    const current = await repository.findById(id);

    if (!current) {
      throw new Error("Group not found");
    }

    const nextPayload = { ...payload };

    if (nextPayload.nome !== undefined) {
      nextPayload.nome = nextPayload.nome.trim();

      if (!nextPayload.nome) {
        throw new Error("Group name is required");
      }
    }

    if (nextPayload.organization_id !== undefined && !nextPayload.organization_id) {
      throw new Error("Organization id is required");
    }

    if (nextPayload.evolution_group_id !== undefined) {
      nextPayload.evolution_group_id = nextPayload.evolution_group_id.trim();

      if (!nextPayload.evolution_group_id) {
        throw new Error("Evolution group id is required");
      }
    }

    if (nextPayload.maturidade !== undefined) {
      nextPayload.maturidade = Number(nextPayload.maturidade);

      if (!Number.isInteger(nextPayload.maturidade) || nextPayload.maturidade < 1 || nextPayload.maturidade > 4) {
        throw new Error("Maturidade must be between 1 and 4");
      }
    }

    return repository.update(id, nextPayload);
  }

  async function remove(id) {
    if (!id) {
      throw new Error("Group id is required");
    }

    const current = await repository.findById(id);

    if (!current) {
      throw new Error("Group not found");
    }

    return repository.delete(id);
  }

  async function getById(id) {
    if (!id) {
      throw new Error("Group id is required");
    }

    return repository.findById(id);
  }

  async function list() {
    return repository.findAll();
  }

  async function listByOrganization(organizationId) {
    if (!organizationId) {
      throw new Error("Organization id is required");
    }

    return repository.listByOrganization(organizationId);
  }

  async function listVideoEnabled() {
    return repository.listVideoEnabled();
  }

  return {
    create,
    delete: remove,
    getById,
    list,
    listByOrganization,
    listVideoEnabled,
    update,
  };
}

module.exports = createGroupsService();
module.exports.createGroupsService = createGroupsService;
