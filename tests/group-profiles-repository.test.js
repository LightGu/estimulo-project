const assert = require("node:assert/strict");

const groupProfilesRepository = require("../src/repositories/group-profiles.repository");

function createMockClient({
  selectResult,
  countResult,
  insertResult,
  deleteResult,
  updateResult,
  targetRowsResult,
  singleResult,
  // Quando true, `eq` continua encadeavel em leituras (para select -> eq -> order -> limit).
  chainReads = false,
} = {}) {
  const calls = [];
  const createBuilder = (tableName) => {
    let lastOp = null;

    const builder = {
      select(columns, options) {
        calls.push({ type: "select", tableName, columns, options });
        lastOp = options && options.count ? "count" : "select";
        return builder;
      },
      insert(payload) {
        calls.push({ type: "insert", tableName, payload });
        lastOp = "insert";
        return builder;
      },
      update(payload) {
        calls.push({ type: "update", tableName, payload });
        lastOp = "update";
        return builder;
      },
      delete() {
        calls.push({ type: "delete", tableName });
        lastOp = "delete";
        return builder;
      },
      in(column, values) {
        calls.push({ type: "in", tableName, column, values });
        return Promise.resolve({ error: null });
      },
      eq(column, value) {
        calls.push({ type: "eq", tableName, column, value });

        if (lastOp === "delete") {
          return builder;
        }

        if (lastOp === "count") {
          return Promise.resolve({ count: countResult, error: null });
        }

        if (lastOp === "select") {
          if (chainReads) {
            return builder;
          }

          return Promise.resolve({ data: targetRowsResult || [], error: null });
        }

        return builder;
      },
      order(column, options) {
        calls.push({ type: "order", tableName, column, options });

        if (chainReads) {
          return builder;
        }

        return Promise.resolve({ data: selectResult, error: null });
      },
      limit(value) {
        calls.push({ type: "limit", tableName, value });
        lastOp = "limit";
        return builder;
      },
      single() {
        return Promise.resolve({ data: updateResult || insertResult, error: null });
      },
      maybeSingle() {
        if (lastOp === "limit") {
          return Promise.resolve({ data: singleResult, error: null });
        }

        return Promise.resolve({ data: deleteResult, error: null });
      },
    };

    return builder;
  };

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

    const trailCount = await groupProfilesRepository.countTrilhaPerfisUsage("profile-1", client);
    assert.equal(trailCount, 3);

    const groupCount = await groupProfilesRepository.countGroupsUsage("profile-1", client);
    assert.equal(groupCount, 3);
  }

  // ---------- update ----------
  {
    const client = createMockClient({ updateResult: { id: "profile-1", nome: "Eufrasio" } });

    const updated = await groupProfilesRepository.update("profile-1", { nome: "Eufrasio" }, client);
    assert.equal(updated.nome, "Eufrasio");
    assert.ok(client.__calls.some((call) => call.type === "update" && call.tableName === "group_profiles" && call.payload.nome === "Eufrasio"));
  }

  // ---------- reassignTrilhaPerfis ----------
  {
    const client = createMockClient({ targetRowsResult: [{ trilha_id: "trilha-1" }] });

    await groupProfilesRepository.reassignTrilhaPerfis("profile-discarded", "profile-survivor", client);

    assert.ok(client.__calls.some((call) => call.type === "delete" && call.tableName === "trilha_perfis"));
    assert.ok(
      client.__calls.some(
        (call) => call.type === "in" && call.tableName === "trilha_perfis" && call.column === "trilha_id"
      )
    );
    assert.ok(
      client.__calls.some(
        (call) => call.type === "update" && call.tableName === "trilha_perfis" && call.payload.profile_id === "profile-survivor"
      )
    );
  }

  // ---------- reassignTrilhaPerfis without overlapping trilhas ----------
  {
    const client = createMockClient({ targetRowsResult: [] });

    await groupProfilesRepository.reassignTrilhaPerfis("profile-discarded", "profile-survivor", client);

    assert.ok(!client.__calls.some((call) => call.type === "delete" && call.tableName === "trilha_perfis"));
    assert.ok(
      client.__calls.some(
        (call) => call.type === "update" && call.tableName === "trilha_perfis" && call.payload.profile_id === "profile-survivor"
      )
    );
  }

  // ---------- reassignGroupsProfile ----------
  {
    const client = createMockClient();

    await groupProfilesRepository.reassignGroupsProfile("profile-discarded", "profile-survivor", client);

    assert.ok(
      client.__calls.some(
        (call) => call.type === "update" && call.tableName === "groups" && call.payload.profile_id === "profile-survivor"
      )
    );
  }

  // ---------- findTrilhaIdsByProfile / findGroupIdsByProfile ----------
  {
    const client = createMockClient({ targetRowsResult: [{ trilha_id: "trilha-1" }, { trilha_id: "trilha-2" }] });

    const trilhaIds = await groupProfilesRepository.findTrilhaIdsByProfile("profile-1", client);
    assert.deepEqual(trilhaIds, ["trilha-1", "trilha-2"]);
  }

  {
    const client = createMockClient({ targetRowsResult: [{ id: "group-1" }] });

    const groupIds = await groupProfilesRepository.findGroupIdsByProfile("profile-1", client);
    assert.deepEqual(groupIds, ["group-1"]);
  }

  // ---------- reassignTrilhaPerfisByTrilhaIds ----------
  {
    const client = createMockClient();

    await groupProfilesRepository.reassignTrilhaPerfisByTrilhaIds("profile-1", "profile-2", ["trilha-a"], client);

    assert.ok(
      client.__calls.some(
        (call) => call.type === "update" && call.tableName === "trilha_perfis" && call.payload.profile_id === "profile-2"
      )
    );
    assert.ok(
      client.__calls.some(
        (call) => call.type === "in" && call.tableName === "trilha_perfis" && call.column === "trilha_id"
      )
    );
  }

  // ---------- reassign helpers are no-ops for empty id lists ----------
  {
    const client = createMockClient();

    await groupProfilesRepository.reassignTrilhaPerfisByTrilhaIds("profile-1", "profile-2", [], client);
    await groupProfilesRepository.reassignGroupsProfileByIds("profile-1", "profile-2", [], client);
    await groupProfilesRepository.insertTrilhaPerfis([], client);

    assert.equal(client.__calls.length, 0);
  }

  // ---------- reassignGroupsProfileByIds ----------
  {
    const client = createMockClient();

    await groupProfilesRepository.reassignGroupsProfileByIds("profile-1", "profile-2", ["group-1"], client);

    assert.ok(
      client.__calls.some(
        (call) => call.type === "update" && call.tableName === "groups" && call.payload.profile_id === "profile-2"
      )
    );
    assert.ok(client.__calls.some((call) => call.type === "in" && call.tableName === "groups" && call.column === "id"));
  }

  // ---------- insertTrilhaPerfis ----------
  {
    const client = createMockClient();

    await groupProfilesRepository.insertTrilhaPerfis(
      [{ trilha_id: "trilha-a", profile_id: "profile-2", perfil: "Maturidade" }],
      client
    );

    assert.ok(client.__calls.some((call) => call.type === "insert" && call.tableName === "trilha_perfis"));
  }

  // ---------- createWithId preserves the original profile id ----------
  {
    const client = createMockClient({ insertResult: { id: "profile-2", nome: "Maturidade" } });

    const restored = await groupProfilesRepository.createWithId({ id: "profile-2", nome: "Maturidade" }, client);

    assert.equal(restored.id, "profile-2");
    assert.ok(
      client.__calls.some(
        (call) => call.type === "insert" && call.tableName === "group_profiles" && call.payload.id === "profile-2"
      )
    );
  }

  // ---------- createMergeRecord / findAllMergeRecords ----------
  {
    const client = createMockClient({ insertResult: { id: "merge-1", survivor_id: "profile-1" } });

    const record = await groupProfilesRepository.createMergeRecord({ survivor_id: "profile-1" }, client);
    assert.equal(record.id, "merge-1");
    assert.ok(client.__calls.some((call) => call.type === "insert" && call.tableName === "group_profile_merges"));
  }

  {
    const client = createMockClient({ selectResult: [{ id: "merge-1" }] });

    const records = await groupProfilesRepository.findAllMergeRecords(client);
    assert.deepEqual(records, [{ id: "merge-1" }]);
  }

  // ---------- findLatestMergeBySurvivorId returns the most recent merge ----------
  {
    const client = createMockClient({ chainReads: true, singleResult: { id: "merge-2", survivor_id: "profile-1" } });

    const record = await groupProfilesRepository.findLatestMergeBySurvivorId("profile-1", client);

    assert.equal(record.id, "merge-2");
    assert.ok(
      client.__calls.some(
        (call) => call.type === "order" && call.tableName === "group_profile_merges" && call.options.ascending === false
      )
    );
  }

  {
    const client = createMockClient({ chainReads: true, singleResult: null });

    const record = await groupProfilesRepository.findLatestMergeBySurvivorId("profile-1", client);
    assert.equal(record, null);
  }

  // ---------- reorder ----------
  {
    const client = createMockClient({ updateResult: { id: "profile-x", ordem: 1 } });

    const result = await groupProfilesRepository.reorder(["profile-2", "profile-1"], client);

    assert.equal(result.length, 2);
    const updateCalls = client.__calls.filter((call) => call.type === "update" && call.tableName === "group_profiles");
    assert.deepEqual(updateCalls.map((call) => call.payload.ordem), [1, 2]);
    const eqCalls = client.__calls.filter((call) => call.type === "eq" && call.tableName === "group_profiles");
    assert.deepEqual(eqCalls.map((call) => call.value), ["profile-2", "profile-1"]);
  }

  // ---------- clearOrdem ----------
  {
    const client = createMockClient();

    await groupProfilesRepository.clearOrdem(["profile-3"], client);

    assert.ok(
      client.__calls.some(
        (call) => call.type === "update" && call.tableName === "group_profiles" && call.payload.ordem === null
      )
    );
    assert.ok(client.__calls.some((call) => call.type === "in" && call.tableName === "group_profiles" && call.column === "id"));
  }

  // ---------- clearOrdem is a no-op for empty id lists ----------
  {
    const client = createMockClient();

    await groupProfilesRepository.clearOrdem([], client);

    assert.equal(client.__calls.length, 0);
  }

  // ---------- removeMergeRecord ----------
  {
    const client = createMockClient();

    await groupProfilesRepository.removeMergeRecord("merge-1", client);

    assert.ok(client.__calls.some((call) => call.type === "delete" && call.tableName === "group_profile_merges"));
  }

  console.log("group profiles repository tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
