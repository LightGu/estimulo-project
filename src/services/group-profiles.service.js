const groupProfilesRepository = require("../repositories/group-profiles.repository");

function normalizeComparableText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

// Colunas jsonb podem voltar como array ou como string JSON, dependendo do driver.
function parseIdList(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean);
  }

  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch (error) {
      return [];
    }
  }

  return [];
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
      repository.countTrilhaPerfisUsage(profile.id),
      repository.countGroupsUsage(profile.id),
    ]);

    if (trailUsage > 0 || groupUsage > 0) {
      throw new Error("Profile is in use and cannot be removed");
    }

    return repository.remove(id);
  }

  async function rename(id, rawNome) {
    if (!id) {
      throw new Error("Profile id is required");
    }

    const nome = String(rawNome || "").trim();

    if (!nome) {
      throw new Error("Nome is required");
    }

    const existing = await repository.findAll();
    const profile = existing.find((item) => item.id === id);

    if (!profile) {
      throw new Error("Profile not found");
    }

    const duplicate = existing.some(
      (item) => item.id !== id && normalizeComparableText(item.nome) === normalizeComparableText(nome)
    );

    if (duplicate) {
      throw new Error("Profile already exists");
    }

    return repository.update(id, { nome });
  }

  async function merge(payload) {
    const profileIds = Array.isArray(payload?.profileIds)
      ? [...new Set(payload.profileIds.map((id) => String(id || "").trim()).filter(Boolean))]
      : [];

    if (profileIds.length !== 2) {
      throw new Error("Exactly two profileIds are required");
    }

    const nome = String(payload?.nome || "").trim();

    if (!nome) {
      throw new Error("Nome is required");
    }

    const existing = await repository.findAll();
    const [survivorId, discardedId] = profileIds;
    const survivor = existing.find((item) => item.id === survivorId);
    const discarded = existing.find((item) => item.id === discardedId);

    if (!survivor || !discarded) {
      throw new Error("Profile not found");
    }

    const duplicate = existing.some(
      (item) =>
        item.id !== survivorId && item.id !== discardedId && normalizeComparableText(item.nome) === normalizeComparableText(nome)
    );

    if (duplicate) {
      throw new Error("Profile already exists");
    }

    // Captura, antes de qualquer escrita, exatamente quais vinculos eram do perfil
    // descartado — e o que a desfusao precisa devolver.
    const [discardedTrilhaIds, discardedGroupIds, survivorTrilhaIds] = await Promise.all([
      repository.findTrilhaIdsByProfile(discardedId),
      repository.findGroupIdsByProfile(discardedId),
      repository.findTrilhaIdsByProfile(survivorId),
    ]);

    // Trilhas que tinham os dois perfis: a fusao apaga a linha duplicada, então a
    // desfusao tera de recriá-la em vez de apenas reapontar.
    const survivorTrilhaIdSet = new Set(survivorTrilhaIds);
    const collapsedTrilhaIds = discardedTrilhaIds.filter((trilhaId) => survivorTrilhaIdSet.has(trilhaId));

    if (normalizeComparableText(survivor.nome) !== normalizeComparableText(nome)) {
      await repository.update(survivorId, { nome });
    }

    await repository.reassignTrilhaPerfis(discardedId, survivorId);
    await repository.reassignGroupsProfile(discardedId, survivorId);
    await repository.remove(discardedId);

    await repository.createMergeRecord({
      survivor_id: survivorId,
      survivor_nome_anterior: survivor.nome,
      discarded_id: discardedId,
      discarded_nome: discarded.nome,
      nome_resultante: nome,
      trilha_ids: discardedTrilhaIds,
      group_ids: discardedGroupIds,
      collapsed_trilha_ids: collapsedTrilhaIds,
    });

    return { ...survivor, nome };
  }

  async function listMergeRecords() {
    if (typeof repository.findAllMergeRecords !== "function") {
      return [];
    }

    return repository.findAllMergeRecords();
  }

  async function unmerge(survivorId) {
    const id = String(survivorId || "").trim();

    if (!id) {
      throw new Error("Profile id is required");
    }

    const existing = await repository.findAll();
    const survivor = existing.find((item) => item.id === id);

    if (!survivor) {
      throw new Error("Profile not found");
    }

    const record = await repository.findLatestMergeBySurvivorId(id);

    if (!record) {
      throw new Error("Profile was not created from a merge");
    }

    const discardedNome = String(record.discarded_nome || "").trim();
    const survivorNomeAnterior = String(record.survivor_nome_anterior || "").trim();

    const nameConflict = existing.some(
      (item) => item.id !== id && normalizeComparableText(item.nome) === normalizeComparableText(discardedNome)
    );

    if (nameConflict) {
      throw new Error("Profile already exists");
    }

    const trilhaIds = parseIdList(record.trilha_ids);
    const groupIds = parseIdList(record.group_ids);
    const collapsedTrilhaIds = new Set(parseIdList(record.collapsed_trilha_ids));

    // Trilhas cujo vinculo foi apagado na fusao voltam como linha nova; as demais
    // apenas reapontam para o perfil restaurado.
    const reassignableTrilhaIds = trilhaIds.filter((trilhaId) => !collapsedTrilhaIds.has(trilhaId));

    const restored = await repository.createWithId({ id: record.discarded_id, nome: discardedNome });

    await repository.reassignTrilhaPerfisByTrilhaIds(id, record.discarded_id, reassignableTrilhaIds);
    await repository.reassignGroupsProfileByIds(id, record.discarded_id, groupIds);

    if (collapsedTrilhaIds.size) {
      await repository.insertTrilhaPerfis(
        [...collapsedTrilhaIds].map((trilhaId) => ({
          trilha_id: trilhaId,
          profile_id: record.discarded_id,
          perfil: discardedNome,
        }))
      );
    }

    let survivorAfter = survivor;

    if (
      survivorNomeAnterior &&
      normalizeComparableText(survivor.nome) !== normalizeComparableText(survivorNomeAnterior)
    ) {
      const survivorNameTaken = existing.some(
        (item) => item.id !== id && normalizeComparableText(item.nome) === normalizeComparableText(survivorNomeAnterior)
      );

      if (!survivorNameTaken) {
        survivorAfter = await repository.update(id, { nome: survivorNomeAnterior });
      }
    }

    await repository.removeMergeRecord(record.id);

    return { restored, survivor: survivorAfter };
  }

  // Ordem de progressao entre perfis (usada pelo checkpoint do motor de
  // sequenciamento). Semantica de substituicao total: perfis presentes em
  // orderedIds recebem ordem 1..N na ordem dada; qualquer perfil existente que NAO
  // esteja na lista sai da jornada automatica (ordem volta a null).
  async function reorder(orderedIds) {
    const ids = Array.isArray(orderedIds)
      ? [...new Set(orderedIds.map((id) => String(id || "").trim()).filter(Boolean))]
      : [];

    const existing = await repository.findAll();
    const existingIds = new Set(existing.map((profile) => profile.id));
    const invalid = ids.find((id) => !existingIds.has(id));

    if (invalid) {
      throw new Error("Profile not found");
    }

    const clearedIds = existing
      .filter((profile) => !ids.includes(profile.id) && profile.ordem !== null && profile.ordem !== undefined)
      .map((profile) => profile.id);

    await repository.clearOrdem(clearedIds);

    if (!ids.length) {
      return [];
    }

    return repository.reorder(ids);
  }

  return {
    create,
    delete: remove,
    list,
    listMergeRecords,
    merge,
    remove,
    rename,
    reorder,
    unmerge,
  };
}

module.exports = createGroupProfilesService();
module.exports.createGroupProfilesService = createGroupProfilesService;
