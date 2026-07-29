const groupProfilesRepository = require("../repositories/group-profiles.repository");

function normalizeComparableText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

function createGroupProfilesService(dependencies = {}) {
  const repository = dependencies.repository || groupProfilesRepository;

  async function list() {
    return repository.findAll();
  }

  async function create(payload) {
    const nome = String(payload?.nome || "").trim();

    if (!nome) {
      throw new Error("Nome is required");
    }

    const existing = await repository.findAll();
    const duplicate = existing.some((item) => normalizeComparableText(item.nome) === normalizeComparableText(nome));

    if (duplicate) {
      throw new Error("Profile already exists");
    }

    return repository.create({ nome });
  }

  async function remove(id) {
    if (!id) {
      throw new Error("Profile id is required");
    }

    const existing = await repository.findAll();
    const profile = existing.find((item) => item.id === id);

    if (!profile) {
      throw new Error("Profile not found");
    }

    const [trailUsage, groupUsage] = await Promise.all([
      repository.countTrilhaPerfisUsage(profile.nome),
      repository.countGroupsUsage(profile.nome),
    ]);

    if (trailUsage > 0 || groupUsage > 0) {
      throw new Error("Profile is in use and cannot be removed");
    }

    return repository.remove(id);
  }

  return {
    create,
    delete: remove,
    list,
    remove,
  };
}

module.exports = createGroupProfilesService();
module.exports.createGroupProfilesService = createGroupProfilesService;
