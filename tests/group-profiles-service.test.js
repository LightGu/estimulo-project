const assert = require("node:assert/strict");

const { createGroupProfilesService } = require("../src/services/group-profiles.service");

async function main() {
  // ---------- list ----------
  {
    const service = createGroupProfilesService({
      repository: { findAll: async () => [{ id: "profile-1", nome: "Infância" }] },
    });

    const profiles = await service.list();
    assert.equal(profiles.length, 1);
  }

  // ---------- create ----------
  {
    const createCalls = [];
    const repository = {
      findAll: async () => [{ id: "profile-1", nome: "Infância" }],
      create: async (payload) => {
        createCalls.push(payload);
        return { id: "profile-2", ...payload };
      },
    };
    const service = createGroupProfilesService({ repository });

    const created = await service.create({ nome: "  Adolescência  " });
    assert.equal(created.nome, "Adolescência");
    assert.equal(createCalls[0].nome, "Adolescência");

    await assert.rejects(() => service.create({ nome: "" }), /Nome is required/);
    await assert.rejects(() => service.create({ nome: "infância" }), /Profile already exists/);
  }

  // ---------- remove ----------
  {
    const removeCalls = [];
    const repository = {
      findAll: async () => [{ id: "profile-1", nome: "Infância" }],
      countTrilhaPerfisUsage: async () => 0,
      countGroupsUsage: async () => 0,
      remove: async (id) => {
        removeCalls.push(id);
        return { id };
      },
    };
    const service = createGroupProfilesService({ repository });

    await service.remove("profile-1");
    assert.deepEqual(removeCalls, ["profile-1"]);

    await assert.rejects(() => service.remove(""), /Profile id is required/);
    await assert.rejects(() => service.remove("missing"), /Profile not found/);
  }

  // ---------- remove blocked when in use ----------
  {
    const repository = {
      findAll: async () => [{ id: "profile-1", nome: "Infância" }],
      countTrilhaPerfisUsage: async () => 2,
      countGroupsUsage: async () => 0,
      remove: async () => {
        throw new Error("should not be called");
      },
    };
    const service = createGroupProfilesService({ repository });

    await assert.rejects(() => service.remove("profile-1"), /Profile is in use and cannot be removed/);
  }

  // ---------- rename ----------
  {
    const updateCalls = [];
    const repository = {
      findAll: async () => [
        { id: "profile-1", nome: "Infância" },
        { id: "profile-2", nome: "Adolescência" },
      ],
      update: async (id, payload) => {
        updateCalls.push({ id, payload });
        return { id, ...payload };
      },
    };
    const service = createGroupProfilesService({ repository });

    const renamed = await service.rename("profile-1", "  Maria  ");
    assert.equal(renamed.nome, "Maria");
    assert.deepEqual(updateCalls[0], { id: "profile-1", payload: { nome: "Maria" } });

    await assert.rejects(() => service.rename("", "Maria"), /Profile id is required/);
    await assert.rejects(() => service.rename("profile-1", ""), /Nome is required/);
    await assert.rejects(() => service.rename("missing", "Maria"), /Profile not found/);
    await assert.rejects(() => service.rename("profile-1", "adolescência"), /Profile already exists/);
  }

  // ---------- merge ----------
  {
    const updateCalls = [];
    const reassignTrilhaCalls = [];
    const reassignGroupCalls = [];
    const removeCalls = [];
    const mergeRecords = [];
    const repository = {
      findAll: async () => [
        { id: "profile-1", nome: "Adolescência" },
        { id: "profile-2", nome: "Maturidade" },
        { id: "profile-3", nome: "Infância" },
      ],
      findTrilhaIdsByProfile: async (profileId) =>
        profileId === "profile-2" ? ["trilha-a", "trilha-shared"] : ["trilha-shared"],
      findGroupIdsByProfile: async () => ["group-1"],
      update: async (id, payload) => {
        updateCalls.push({ id, payload });
        return { id, ...payload };
      },
      reassignTrilhaPerfis: async (fromId, toId) => {
        reassignTrilhaCalls.push({ fromId, toId });
      },
      reassignGroupsProfile: async (fromId, toId) => {
        reassignGroupCalls.push({ fromId, toId });
      },
      remove: async (id) => {
        removeCalls.push(id);
        return { id };
      },
      createMergeRecord: async (payload) => {
        mergeRecords.push(payload);
        return { id: "merge-1", ...payload };
      },
    };
    const service = createGroupProfilesService({ repository });

    const merged = await service.merge({ profileIds: ["profile-1", "profile-2"], nome: "Eufrasio" });

    assert.equal(merged.nome, "Eufrasio");
    assert.deepEqual(updateCalls[0], { id: "profile-1", payload: { nome: "Eufrasio" } });
    assert.deepEqual(reassignTrilhaCalls[0], { fromId: "profile-2", toId: "profile-1" });
    assert.deepEqual(reassignGroupCalls[0], { fromId: "profile-2", toId: "profile-1" });
    assert.deepEqual(removeCalls, ["profile-2"]);

    // O historico guarda o necessario para reverter, incluindo o nome anterior do
    // sobrevivente e as trilhas cujo vinculo duplicado foi colapsado.
    assert.deepEqual(mergeRecords[0], {
      survivor_id: "profile-1",
      survivor_nome_anterior: "Adolescência",
      discarded_id: "profile-2",
      discarded_nome: "Maturidade",
      nome_resultante: "Eufrasio",
      trilha_ids: ["trilha-a", "trilha-shared"],
      group_ids: ["group-1"],
      collapsed_trilha_ids: ["trilha-shared"],
    });

    await assert.rejects(
      () => service.merge({ profileIds: ["profile-1"], nome: "Eufrasio" }),
      /Exactly two profileIds are required/
    );
    await assert.rejects(() => service.merge({ profileIds: ["profile-1", "profile-2"], nome: "" }), /Nome is required/);
    await assert.rejects(
      () => service.merge({ profileIds: ["profile-1", "missing"], nome: "Eufrasio" }),
      /Profile not found/
    );
    await assert.rejects(
      () => service.merge({ profileIds: ["profile-1", "profile-2"], nome: "infância" }),
      /Profile already exists/
    );
  }

  // ---------- unmerge ----------
  {
    const createWithIdCalls = [];
    const reassignTrilhaCalls = [];
    const reassignGroupCalls = [];
    const insertedTrilhaPerfis = [];
    const updateCalls = [];
    const removedMergeRecords = [];
    const repository = {
      findAll: async () => [
        { id: "profile-1", nome: "Eufrasio" },
        { id: "profile-3", nome: "Infância" },
      ],
      findLatestMergeBySurvivorId: async (survivorId) =>
        survivorId === "profile-1"
          ? {
              id: "merge-1",
              survivor_id: "profile-1",
              survivor_nome_anterior: "Adolescência",
              discarded_id: "profile-2",
              discarded_nome: "Maturidade",
              nome_resultante: "Eufrasio",
              trilha_ids: ["trilha-a", "trilha-shared"],
              group_ids: ["group-1"],
              collapsed_trilha_ids: ["trilha-shared"],
            }
          : null,
      createWithId: async (payload) => {
        createWithIdCalls.push(payload);
        return payload;
      },
      reassignTrilhaPerfisByTrilhaIds: async (fromId, toId, trilhaIds) => {
        reassignTrilhaCalls.push({ fromId, toId, trilhaIds });
      },
      reassignGroupsProfileByIds: async (fromId, toId, groupIds) => {
        reassignGroupCalls.push({ fromId, toId, groupIds });
      },
      insertTrilhaPerfis: async (rows) => {
        insertedTrilhaPerfis.push(...rows);
      },
      update: async (id, payload) => {
        updateCalls.push({ id, payload });
        return { id, ...payload };
      },
      removeMergeRecord: async (id) => {
        removedMergeRecords.push(id);
      },
    };
    const service = createGroupProfilesService({ repository });

    const result = await service.unmerge("profile-1");

    assert.deepEqual(createWithIdCalls[0], { id: "profile-2", nome: "Maturidade" });
    // Somente as trilhas nao colapsadas sao reapontadas...
    assert.deepEqual(reassignTrilhaCalls[0], {
      fromId: "profile-1",
      toId: "profile-2",
      trilhaIds: ["trilha-a"],
    });
    // ...e a colapsada e recriada como vinculo novo.
    assert.deepEqual(insertedTrilhaPerfis, [
      { trilha_id: "trilha-shared", profile_id: "profile-2", perfil: "Maturidade" },
    ]);
    assert.deepEqual(reassignGroupCalls[0], { fromId: "profile-1", toId: "profile-2", groupIds: ["group-1"] });
    // O sobrevivente volta ao nome que tinha antes da fusao.
    assert.deepEqual(updateCalls[0], { id: "profile-1", payload: { nome: "Adolescência" } });
    assert.equal(result.survivor.nome, "Adolescência");
    assert.equal(result.restored.nome, "Maturidade");
    assert.deepEqual(removedMergeRecords, ["merge-1"]);

    await assert.rejects(() => service.unmerge(""), /Profile id is required/);
    await assert.rejects(() => service.unmerge("missing"), /Profile not found/);
    await assert.rejects(() => service.unmerge("profile-3"), /Profile was not created from a merge/);
  }

  // ---------- unmerge blocked when restored name is taken ----------
  {
    const repository = {
      findAll: async () => [
        { id: "profile-1", nome: "Eufrasio" },
        { id: "profile-9", nome: "maturidade" },
      ],
      findLatestMergeBySurvivorId: async () => ({
        id: "merge-1",
        survivor_id: "profile-1",
        survivor_nome_anterior: "Adolescência",
        discarded_id: "profile-2",
        discarded_nome: "Maturidade",
        trilha_ids: [],
        group_ids: [],
        collapsed_trilha_ids: [],
      }),
      createWithId: async () => {
        throw new Error("should not be called");
      },
    };
    const service = createGroupProfilesService({ repository });

    await assert.rejects(() => service.unmerge("profile-1"), /Profile already exists/);
  }

  // ---------- unmerge tolerates jsonb columns returned as strings ----------
  {
    const reassignTrilhaCalls = [];
    const repository = {
      findAll: async () => [{ id: "profile-1", nome: "Eufrasio" }],
      findLatestMergeBySurvivorId: async () => ({
        id: "merge-1",
        survivor_id: "profile-1",
        survivor_nome_anterior: "Eufrasio",
        discarded_id: "profile-2",
        discarded_nome: "Maturidade",
        trilha_ids: '["trilha-a"]',
        group_ids: '["group-1"]',
        collapsed_trilha_ids: "[]",
      }),
      createWithId: async (payload) => payload,
      reassignTrilhaPerfisByTrilhaIds: async (fromId, toId, trilhaIds) => {
        reassignTrilhaCalls.push(trilhaIds);
      },
      reassignGroupsProfileByIds: async () => {},
      removeMergeRecord: async () => {},
    };
    const service = createGroupProfilesService({ repository });

    await service.unmerge("profile-1");
    assert.deepEqual(reassignTrilhaCalls[0], ["trilha-a"]);
  }

  console.log("group profiles service tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
