const organizationsRepository = require("../repositories/organizations.repository");

function normalizeNullableText(value, fieldName) {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string or null`);
  }

  const normalized = value.trim();

  return normalized || null;
}

function createOrganizationsService(dependencies = {}) {
  const repository = dependencies.repository || organizationsRepository;

  async function create(payload) {
    const nome = payload?.nome?.trim();

    if (!nome) {
      throw new Error("Organization name is required");
    }

    const existing = await repository.findAll();
    const duplicate = existing.some((item) => item.nome?.toLowerCase() === nome.toLowerCase());

    if (duplicate) {
      throw new Error("Organization already exists");
    }

    const nextPayload = { ...payload, nome };

    if (nextPayload.descricao !== undefined) {
      nextPayload.descricao = normalizeNullableText(nextPayload.descricao, "Descricao");
    }

    if (nextPayload.programa !== undefined) {
      nextPayload.programa = normalizeNullableText(nextPayload.programa, "Programa");
    }

    return repository.create(nextPayload);
  }

  async function update(id, payload) {
    if (!id) {
      throw new Error("Organization id is required");
    }

    if (!payload || Object.keys(payload).length === 0) {
      throw new Error("At least one field is required");
    }

    const current = await repository.findById(id);

    if (!current) {
      throw new Error("Organization not found");
    }

    const nextPayload = { ...payload };

    if (nextPayload.nome !== undefined) {
      nextPayload.nome = nextPayload.nome.trim();

      if (!nextPayload.nome) {
        throw new Error("Organization name is required");
      }
    }

    if (nextPayload.descricao !== undefined) {
      nextPayload.descricao = normalizeNullableText(nextPayload.descricao, "Descricao");
    }

    if (nextPayload.programa !== undefined) {
      nextPayload.programa = normalizeNullableText(nextPayload.programa, "Programa");
    }

    return repository.update(id, nextPayload);
  }

  async function remove(id) {
    if (!id) {
      throw new Error("Organization id is required");
    }

    const current = await repository.findById(id);

    if (!current) {
      throw new Error("Organization not found");
    }

    return repository.delete(id);
  }

  async function getById(id) {
    if (!id) {
      throw new Error("Organization id is required");
    }

    return repository.findById(id);
  }

  async function list() {
    return repository.findAll();
  }

  return {
    create,
    delete: remove,
    getById,
    list,
    update,
  };
}

module.exports = createOrganizationsService();
module.exports.createOrganizationsService = createOrganizationsService;
