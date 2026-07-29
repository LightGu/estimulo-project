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

  console.log("group profiles service tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
