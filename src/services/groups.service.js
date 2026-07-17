const groupsRepository = require("../repositories/groups.repository");
const organizationsRepository = require("../repositories/organizations.repository");
const { fetchAllGroupsFromEvolution } = require("./evolution");

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function countParticipants(group) {
  const participants = firstDefined(group?.participants, group?.Participants, group?.participantsIds, group?.participantIds);

  if (Array.isArray(participants)) {
    return participants.length;
  }

  const count = firstDefined(
    group?.participantsCount,
    group?.participantCount,
    group?.membersCount,
    group?.memberCount,
    group?.size,
    group?._count?.participants,
  );
  const numberCount = Number(count);

  return Number.isFinite(numberCount) && numberCount >= 0 ? numberCount : 0;
}

function extractEvolutionGroups(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  if (Array.isArray(payload?.groups)) {
    return payload.groups;
  }

  if (Array.isArray(payload?.response)) {
    return payload.response;
  }

  return [];
}

function normalizeEvolutionGroup(group) {
  const id = String(firstDefined(group?.id, group?.jid, group?.JID, group?.remoteJid, group?.groupJid) || "").trim();
  const nome = String(firstDefined(group?.subject, group?.name, group?.Name, group?.nome) || "").trim();

  if (!id || !nome) {
    return null;
  }

  return {
    id,
    nome,
    quantidade_membros: countParticipants(group),
  };
}

function normalizeEvolutionGroups(payload) {
  return extractEvolutionGroups(payload)
    .map(normalizeEvolutionGroup)
    .filter(Boolean);
}

function createGroupsService(dependencies = {}) {
  const repository = dependencies.repository || groupsRepository;
  const organizationRepository = dependencies.organizationRepository || organizationsRepository;
  const fetchEvolutionGroups = dependencies.fetchEvolutionGroups || fetchAllGroupsFromEvolution;

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

  async function listWithoutSegment() {
    return repository.listWithoutSegment();
  }

  async function syncGroupsFromEvolution(options = {}) {
    const organizationId = options.organization_id || options.organizationId;
    const maturidade = Number(options.maturidade || options.defaultMaturidade || 1);

    if (!organizationId) {
      throw new Error("Organization id is required");
    }

    if (!Number.isInteger(maturidade) || maturidade < 1 || maturidade > 4) {
      throw new Error("Maturidade must be between 1 and 4");
    }

    const organization = await organizationRepository.findById(organizationId);

    if (!organization) {
      throw new Error("Organization not found");
    }

    const response = await fetchEvolutionGroups();
    const evolutionGroups = extractEvolutionGroups(response.data ?? response);
    const seen = new Set();
    const result = {
      inserted: 0,
      updated: 0,
      ignored: 0,
      groups: [],
    };

    for (const rawGroup of evolutionGroups) {
      const group = normalizeEvolutionGroup(rawGroup);

      if (!group) {
        result.ignored += 1;
        continue;
      }

      const dedupeKey = group.id.toLowerCase();

      if (seen.has(dedupeKey)) {
        result.ignored += 1;
        continue;
      }

      seen.add(dedupeKey);

      const existing = await repository.findByEvolutionGroupId(group.id);
      const payload = {
        nome: group.nome,
        quantidade_membros: group.quantidade_membros,
      };

      if (existing) {
        const updated = await repository.update(existing.id, payload);
        result.updated += 1;
        result.groups.push({
          id: group.id,
          nome: updated?.nome || group.nome,
          quantidade_membros: updated?.quantidade_membros ?? group.quantidade_membros,
        });
        continue;
      }

      const created = await repository.create({
        ...payload,
        organization_id: organizationId,
        evolution_group_id: group.id,
        segmento: null,
        envia_video: false,
        maturidade,
      });

      result.inserted += 1;
      result.groups.push({
        id: group.id,
        nome: created?.nome || group.nome,
        quantidade_membros: created?.quantidade_membros ?? group.quantidade_membros,
      });
    }

    return result;
  }

  return {
    create,
    delete: remove,
    getById,
    list,
    listByOrganization,
    listVideoEnabled,
    listWithoutSegment,
    syncGroupsFromEvolution,
    update,
  };
}

module.exports = createGroupsService();
module.exports.createGroupsService = createGroupsService;
module.exports.normalizeEvolutionGroups = normalizeEvolutionGroups;
