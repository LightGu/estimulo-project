const assert = require("node:assert/strict");

const trilhaDesviosRepository = require("../src/repositories/trilha-desvios.repository");

// trilha-sequence-service.test.js exercita a logica de resolucao de desvio,
// mas sempre com um mock em memoria feito a mao dentro daquele arquivo - a
// query real deste repositorio (tabela, filtro, ordenacao) nunca era checada
// diretamente. Segue o mesmo padrao de fake client de tests/repositories.test.js.

function createMockClient(seedRows) {
  const calls = [];

  const builder = (rows) => ({
    select() {
      return this;
    },
    insert(payload) {
      calls.push({ type: "insert", payload });
      this._insertPayload = payload;
      return this;
    },
    delete() {
      calls.push({ type: "delete" });
      this._deleted = true;
      return this;
    },
    eq(column, value) {
      calls.push({ type: "eq", column, value });
      this._filterColumn = column;
      this._filterValue = value;
      return this;
    },
    order(column, options) {
      calls.push({ type: "order", column, options });
      return this;
    },
    maybeSingle() {
      if (this._filterColumn === "id") {
        return Promise.resolve({ data: rows.find((row) => row.id === this._filterValue) || null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    single() {
      if (this._insertPayload) {
        const created = { id: "desvio-novo", ...this._insertPayload };
        return Promise.resolve({ data: created, error: null });
      }
      return Promise.resolve({ data: rows[0] || null, error: null });
    },
    then(resolve) {
      if (this._filterColumn === "profile_id") {
        resolve({ data: rows.filter((row) => row.profile_id === this._filterValue), error: null });
        return;
      }
      resolve({ data: rows, error: null });
    },
  });

  return {
    from(tableName) {
      calls.push({ type: "from", tableName });
      return builder(seedRows);
    },
    __calls: calls,
  };
}

async function main() {
  const seedRows = [
    { id: "desvio-1", profile_id: "profile-1", after_trilha_id: "trilha-1", setor: "vendas", trilha_destino_id: "trilha-2" },
    { id: "desvio-2", profile_id: "profile-2", after_trilha_id: null, setor: "suporte", trilha_destino_id: "trilha-3" },
  ];

  // ---------- listByProfile: filtra pela tabela/coluna certas ----------
  {
    const client = createMockClient(seedRows);
    const result = await trilhaDesviosRepository.listByProfile("profile-1", client);

    assert.deepEqual(result, [seedRows[0]]);
    assert.ok(client.__calls.some((call) => call.type === "from" && call.tableName === "trilha_perfil_desvios"));
    assert.ok(client.__calls.some((call) => call.type === "eq" && call.column === "profile_id" && call.value === "profile-1"));
    assert.ok(client.__calls.some((call) => call.type === "order" && call.column === "created_at"));
  }

  // ---------- listAll: sem filtro, devolve tudo ----------
  {
    const client = createMockClient(seedRows);
    const result = await trilhaDesviosRepository.listAll(client);
    assert.deepEqual(result, seedRows);
  }

  // ---------- findById ----------
  {
    const client = createMockClient(seedRows);
    const found = await trilhaDesviosRepository.findById("desvio-2", client);
    assert.deepEqual(found, seedRows[1]);

    const notFound = await trilhaDesviosRepository.findById("nao-existe", client);
    assert.equal(notFound, null);
  }

  // ---------- create ----------
  {
    const client = createMockClient(seedRows);
    const payload = { profile_id: "profile-1", after_trilha_id: "trilha-1", setor: "financeiro", trilha_destino_id: "trilha-4" };
    const created = await trilhaDesviosRepository.create(payload, client);

    assert.equal(created.profile_id, "profile-1");
    assert.equal(created.setor, "financeiro");
    assert.ok(client.__calls.some((call) => call.type === "insert" && call.payload === payload));
  }

  // ---------- remove ----------
  {
    const client = createMockClient(seedRows);
    await trilhaDesviosRepository.remove("desvio-1", client);
    assert.ok(client.__calls.some((call) => call.type === "delete"));
    assert.ok(client.__calls.some((call) => call.type === "eq" && call.column === "id" && call.value === "desvio-1"));
  }

  // ---------- erro do Postgrest propaga (nunca engole silenciosamente) ----------
  {
    const errorClient = {
      from() {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          order() {
            return Promise.resolve({ data: null, error: new Error("conexao com o banco falhou") });
          },
        };
      },
    };

    await assert.rejects(() => trilhaDesviosRepository.listByProfile("profile-1", errorClient), /conexao com o banco falhou/);
  }

  console.log("trilha-desvios repository tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
