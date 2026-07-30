const assert = require("node:assert/strict");

const campaignVideoCaptionsRepository = require("../src/repositories/campaign-video-captions.repository");

// Fake do client do Supabase: registra as chamadas para que os testes verifiquem
// o payload enviado, e resolve na ponta da cadeia (.single() ou .select() final).
function createMockClient({ rows = [], row = {} } = {}) {
  const calls = [];
  const createBuilder = (tableName) => {
    let lastOp = null;

    const builder = {
      insert(payload) {
        calls.push({ type: "insert", tableName, payload });
        lastOp = "insert";
        return builder;
      },
      upsert(payload, options) {
        calls.push({ type: "upsert", tableName, payload, options });
        lastOp = "upsert";
        return builder;
      },
      update(payload) {
        calls.push({ type: "update", tableName, payload });
        lastOp = "update";
        return builder;
      },
      eq(column, value) {
        calls.push({ type: "eq", tableName, column, value });
        return builder;
      },
      select(columns) {
        calls.push({ type: "select", tableName, columns });

        // upsert em lote nao usa .single(): a promise resolve aqui mesmo.
        if (lastOp === "upsert") {
          return Promise.resolve({ data: rows, error: null });
        }

        return builder;
      },
      single() {
        calls.push({ type: "single", tableName });
        return Promise.resolve({ data: row, error: null });
      },
    };

    return builder;
  };

  return {
    calls,
    from(tableName) {
      calls.push({ type: "from", tableName });
      return createBuilder(tableName);
    },
  };
}

// A geracao de legendas de uma campanha e sequencial (um video por vez), mas todas
// as linhas nascem juntas porque a tela da Etapa 2 usa a contagem de linhas como
// total esperado. Nascer em "processando" fazia a tela mostrar todos os videos como
// "Processando" ao mesmo tempo, como se houvesse uma requisicao de legenda por
// video em paralelo. O status inicial precisa ser "pendente" (na fila).
async function testCreateManyPendingCreatesRowsQueuedNotProcessing() {
  const client = createMockClient({ rows: [{ id: "row-1" }, { id: "row-2" }] });

  const inserted = await campaignVideoCaptionsRepository.createManyPending(
    [
      { campaign_id: "campaign-1", group_id: "group-1", video_id: "video-1" },
      { campaign_id: "campaign-1", group_id: "group-2", video_id: "video-2" },
    ],
    client
  );

  assert.deepEqual(inserted, [{ id: "row-1" }, { id: "row-2" }]);

  const upsert = client.calls.find((call) => call.type === "upsert");
  assert.ok(upsert, "as linhas sao criadas em um unico upsert");
  assert.equal(upsert.payload.length, 2);
  upsert.payload.forEach((payload) => {
    assert.equal(payload.status, "pendente", "nenhuma linha nasce em processando");
    assert.equal(payload.erro_mensagem, null);
  });

  // Upsert (e nao insert) porque (campaign_id, group_id, video_id) e UNIQUE: numa
  // segunda rodada de geracao a linha existente volta para a fila.
  assert.deepEqual(upsert.options, { onConflict: "campaign_id,group_id,video_id" });
}

async function testCreateManyPendingSkipsRequestWhenThereIsNothingToCreate() {
  const client = createMockClient();

  assert.deepEqual(await campaignVideoCaptionsRepository.createManyPending([], client), []);
  assert.deepEqual(await campaignVideoCaptionsRepository.createManyPending(undefined, client), []);
  assert.equal(client.calls.length, 0);
}

async function testCreatePendingCreatesRowQueued() {
  const client = createMockClient({ row: { id: "row-1", status: "pendente" } });

  const created = await campaignVideoCaptionsRepository.createPending(
    { campaign_id: "campaign-1", group_id: "group-1", video_id: "video-1" },
    client
  );

  assert.deepEqual(created, { id: "row-1", status: "pendente" });

  const insert = client.calls.find((call) => call.type === "insert");
  assert.equal(insert.payload.status, "pendente", "quem marca processando e o servico, na vez do video");
}

// Marcar "processando" e o passo que o servico executa no instante em que a
// legenda daquele video comeca a ser consultada/gerada.
async function testMarkProcessingMovesRowOutOfTheQueue() {
  const client = createMockClient({ row: { id: "row-1", status: "processando" } });

  const updated = await campaignVideoCaptionsRepository.markProcessing("row-1", client);

  assert.deepEqual(updated, { id: "row-1", status: "processando" });

  const update = client.calls.find((call) => call.type === "update");
  assert.equal(update.payload.status, "processando");
  assert.equal(update.payload.erro_mensagem, null);

  const eq = client.calls.find((call) => call.type === "eq");
  assert.deepEqual({ column: eq.column, value: eq.value }, { column: "id", value: "row-1" });
}

async function main() {
  await testCreateManyPendingCreatesRowsQueuedNotProcessing();
  await testCreateManyPendingSkipsRequestWhenThereIsNothingToCreate();
  await testCreatePendingCreatesRowQueued();
  await testMarkProcessingMovesRowOutOfTheQueue();

  console.log("campaign-video-captions-repository tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
