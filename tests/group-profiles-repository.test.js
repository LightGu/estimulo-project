const assert = require("node:assert/strict");

const groupProfilesRepository = require("../src/repositories/group-profiles.repository");

function createMockClient({ selectResult, countResult, insertResult, deleteResult } = {}) {
  const calls = [];
  const createBuilder = (tableName) => ({
    select(columns, options) {
      calls.push({ type: "select", tableName, columns, options });
      if (options && options.count) {
        return this;
      }
      return this;
    },
    insert(payload) {
      calls.push({ type: "insert", tableName, payload });
      return this;
    },
    delete() {
      calls.push({ type: "delete", tableName });
      return this;
    },
    eq(column, value) {
      calls.push({ type: "eq", tableName, column, value });
      if (tableName === "trilha_perfis" || tableName === "groups") {
        return Promise.resolve({ count: countResult, error: null });
      }
      return this;
    },
    order(column, options) {
      calls.push({ type: "order", tableName, column, options });
      return Promise.resolve({ data: selectResult, error: null });
    },
    single() {
      return Promise.resolve({ data: insertResult, error: null });
    },
    maybeSingle() {
      return Promise.resolve({ data: deleteResult, error: null });
    },
  });

  const client = {
    from(tableName) {
      return createBuilder(tableName);
    },
    __calls: calls,
  };

  return client;
}

async function main() {
  // ---------- findAll ----------
  {
    const client = createMockClient({
      selectResult: [
        { id: "profile-1", nome: "Pré-infância" },
        { id: "profile-2", nome: "Infância" },
      ],
    });

    const profiles = await groupProfilesRepository.findAll(client);
    assert.equal(profiles.length, 2);
    assert.equal(profiles[0].nome, "Pré-infância");
  }

  // ---------- create ----------
  {
    const client = createMockClient({ insertResult: { id: "profile-3", nome: "Novo Perfil" } });

    const created = await groupProfilesRepository.create({ nome: "Novo Perfil" }, client);
    assert.equal(created.nome, "Novo Perfil");
    assert.ok(client.__calls.some((call) => call.type === "insert" && call.payload.nome === "Novo Perfil"));
  }

  // ---------- remove ----------
  {
    const client = createMockClient({ deleteResult: { id: "profile-1", nome: "Pré-infância" } });

    const removed = await groupProfilesRepository.remove("profile-1", client);
    assert.equal(removed.id, "profile-1");
    assert.ok(client.__calls.some((call) => call.type === "delete" && call.tableName === "group_profiles"));
  }

  // ---------- countTrilhaPerfisUsage / countGroupsUsage ----------
  {
    const client = createMockClient({ countResult: 3 });

    const trailCount = await groupProfilesRepository.countTrilhaPerfisUsage("Infância", client);
    assert.equal(trailCount, 3);

    const groupCount = await groupProfilesRepository.countGroupsUsage("Infância", client);
    assert.equal(groupCount, 3);
  }

  console.log("group profiles repository tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
