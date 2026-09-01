const assert = require("node:assert/strict");

const organizationsRepository = require("../src/repositories/organizations.repository");
const { createOrganizationsService } = require("../src/services/organizations.service");
const createApp = require("../src/api/app");

// Regressao para o bug de producao corrigido em
// supabase/migrations/202608280001_fix_organizations_schema_drift.sql: todo
// PATCH /organizations quebrava com 500 porque o banco real tinha a coluna
// "description" (nunca migrada para "descricao") e faltava "updated_at". Os
// testes existentes (repositories.test.js, api.test.js) usam um mock do
// Supabase que aceita QUALQUER payload sem checar nome de coluna - entao
// nao teriam pegado esse bug antes nem pegam uma regressao futura.
//
// Este client "estrito" espelha o schema real pos-migration (id, nome,
// descricao, programa, created_at, updated_at) e devolve o mesmo erro que o
// Postgrest devolve de verdade (PGRST204) quando o payload usa uma coluna
// que nao existe. Se o service/repository voltarem a mandar "description"
// (ou qualquer outra coluna incorreta), o teste falha sem precisar de um
// Postgres real.
const KNOWN_COLUMNS = new Set(["id", "nome", "descricao", "programa", "created_at", "updated_at"]);

function postgrestUnknownColumnError(column) {
  const error = new Error(`Could not find the '${column}' column of 'organizations' in the schema cache`);
  error.code = "PGRST204";
  return error;
}

function createStrictOrganizationsClient(seedRows = []) {
  const rows = new Map(seedRows.map((row) => [row.id, row]));
  let nextId = seedRows.length + 1;

  return {
    from(table) {
      assert.equal(table, "organizations", "este fake so conhece a tabela organizations");

      let mode = "select";
      let filterId = null;
      let payload = null;

      async function exec() {
        if (mode === "insert") {
          for (const column of Object.keys(payload || {})) {
            if (!KNOWN_COLUMNS.has(column)) throw postgrestUnknownColumnError(column);
          }
          const now = new Date().toISOString();
          const row = { id: `org-${nextId++}`, created_at: now, updated_at: now, ...payload };
          rows.set(row.id, row);
          return { data: row, error: null };
        }

        if (mode === "update") {
          for (const column of Object.keys(payload || {})) {
            if (!KNOWN_COLUMNS.has(column)) throw postgrestUnknownColumnError(column);
          }
          const existing = rows.get(filterId);
          if (!existing) return { data: null, error: null };
          const updated = { ...existing, ...payload, updated_at: new Date().toISOString() };
          rows.set(filterId, updated);
          return { data: updated, error: null };
        }

        if (mode === "delete") {
          const existing = rows.get(filterId) || null;
          rows.delete(filterId);
          return { data: existing, error: null };
        }

        if (filterId) {
          return { data: rows.get(filterId) || null, error: null };
        }

        return { data: Array.from(rows.values()), error: null };
      }

      const builder = {
        select() {
          return this;
        },
        insert(nextPayload) {
          mode = "insert";
          payload = nextPayload;
          return this;
        },
        update(nextPayload) {
          mode = "update";
          payload = nextPayload;
          return this;
        },
        delete() {
          mode = "delete";
          return this;
        },
        eq(column, value) {
          if (column === "id") filterId = value;
          return this;
        },
        order() {
          return this;
        },
        async single() {
          const { data, error } = await runSafely();
          if (error) throw error;
          return { data, error: null };
        },
        async maybeSingle() {
          const { data, error } = await runSafely();
          if (error) throw error;
          return { data, error: null };
        },
        then(resolve, reject) {
          runSafely().then(resolve, reject);
        },
      };

      async function runSafely() {
        try {
          return await exec();
        } catch (error) {
          return { data: null, error };
        }
      }

      return builder;
    },
  };
}

function repositoryBoundTo(client) {
  return {
    create: (payload) => organizationsRepository.create(payload, client),
    update: (id, payload) => organizationsRepository.update(id, payload, client),
    findById: (id) => organizationsRepository.findById(id, client),
    findAll: () => organizationsRepository.findAll(client),
    delete: (id) => organizationsRepository.remove(id, client),
  };
}

async function main() {
  // ---------- sanidade: o client estrito reproduz a falha real de producao ----------
  {
    const client = createStrictOrganizationsClient([{ id: "org-1", nome: "AMBEV", descricao: null, programa: null }]);

    await assert.rejects(
      () => organizationsRepository.update("org-1", { description: "texto" }, client),
      (error) => error.code === "PGRST204" && /description/.test(error.message)
    );
  }

  // ---------- guarda de regressao: service + repository reais contra o schema real ----------
  {
    const client = createStrictOrganizationsClient();
    const repository = repositoryBoundTo(client);
    const organizationsService = createOrganizationsService({ repository });

    const created = await organizationsService.create({
      nome: "Acme",
      descricao: "Descricao da Acme",
      programa: "Programa X",
    });
    assert.equal(created.nome, "Acme");
    assert.equal(created.descricao, "Descricao da Acme");

    const updated = await organizationsService.update(created.id, { descricao: "Nova descricao" });
    assert.equal(updated.descricao, "Nova descricao");
    assert.ok(updated.updated_at);

    // Campo null explicito (usado pela tela para "limpar" a descricao) tambem
    // e uma coluna valida, nao deve estourar PGRST204.
    const cleared = await organizationsService.update(created.id, { descricao: null });
    assert.equal(cleared.descricao, null);

    const found = await organizationsService.getById(created.id);
    assert.equal(found.nome, "Acme");

    const list = await organizationsService.list();
    assert.equal(list.length, 1);

    const removed = await organizationsService.delete(created.id);
    assert.equal(removed.id, created.id);
  }

  // ---------- contrato HTTP: mesma falha, respondida sem vazar detalhe interno ----------
  // Simula o mesmo formato de bug historico (uma coluna que nao existe mais
  // no schema) chegando ate o controller real via HTTP, para garantir que o
  // catch-all continua devolvendo um 500 limpo em vez de vazar a mensagem
  // crua do Postgrest ou derrubar o processo.
  {
    const client = createStrictOrganizationsClient([{ id: "org-1", nome: "AMBEV", descricao: null, programa: null }]);
    const regressedRepository = {
      ...repositoryBoundTo(client),
      // Simula uma regressao futura (ex.: alguem reintroduzindo "description").
      update: (id, payload) =>
        organizationsRepository.update(id, { ...payload, description: payload.descricao }, client),
    };
    const organizationService = createOrganizationsService({ repository: regressedRepository });

    const app = createApp({
      authGate: { enabled: false },
      organizationService,
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      const response = await fetch(`${baseUrl}/organizations/org-1`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ descricao: "tentativa" }),
      });

      assert.equal(response.status, 500);
      const payload = await response.json();
      assert.deepEqual(payload, { error: "Internal server error" }, "nunca deve vazar a mensagem crua do Postgrest");
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }

  console.log("organizations schema contract tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
