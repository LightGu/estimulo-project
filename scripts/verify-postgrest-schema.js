/*
  Confirma pelo PostgREST (o caminho que a aplicacao usa de verdade) que as
  migrations chegaram ao cache de schema.

  Por que separado do verify-pending-migrations.js: aquele fala SQL direto pelo
  pooler. A aplicacao NAO fala SQL - fala PostgREST via src/database/client.js, e
  o PostgREST mantem um cache de schema proprio. Uma coluna que existe no
  Postgres mas nao no cache do PostgREST ainda responde 42703 / PGRST204, que era
  exatamente o erro que fazia o INSERT INTEIRO de `logs` ser recusado.
*/
require("dotenv").config({ quiet: true });

const client = require("../src/database/client");

async function main() {
  const falhas = [];

  // 1. dispatch_ref visivel ao PostgREST: um select da coluna basta - se ela nao
  //    estiver no cache de schema, a resposta e' erro, nao lista vazia.
  const dispatchRef = await client.from("logs").select("id, dispatch_ref").limit(1);

  if (dispatchRef.error) {
    falhas.push(`logs.dispatch_ref: ${dispatchRef.error.code} ${dispatchRef.error.message}`);
    console.log("FALHA logs.dispatch_ref nao visivel ao PostgREST");
  } else {
    console.log("OK   logs.dispatch_ref visivel ao PostgREST");
  }

  // 2. Filtrar pela coluna tambem, que e' o uso real (o relatorio busca por ref).
  const filtro = await client.from("logs").select("id").eq("dispatch_ref", "d:0:0:0").limit(1);

  if (filtro.error) {
    falhas.push(`filtro por dispatch_ref: ${filtro.error.code} ${filtro.error.message}`);
    console.log("FALHA filtro por dispatch_ref");
  } else {
    console.log("OK   filtro .eq('dispatch_ref') aceito");
  }

  // 3. A classificacao 'capacitacao' pelo PostgREST. Este e' o caminho exato do
  //    incidente: dispatchAdHoc grava a campanha ancora por aqui. A linha e
  //    apagada em seguida - o PostgREST nao tem transacao/rollback.
  const insert = await client
    .from("campaigns")
    .insert({ classificacao: "capacitacao", titulo: "VERIFICACAO_MIGRATION_APAGAR" })
    .select("id")
    .single();

  if (insert.error) {
    falhas.push(`campaigns classificacao=capacitacao: ${insert.error.code} ${insert.error.message}`);
    console.log("FALHA insert de classificacao='capacitacao' pelo PostgREST");
  } else {
    console.log("OK   insert de classificacao='capacitacao' aceito pelo PostgREST");

    const remocao = await client.from("campaigns").delete().eq("id", insert.data.id);

    if (remocao.error) {
      falhas.push(`NAO CONSEGUI APAGAR a campanha de teste ${insert.data.id}: ${remocao.error.message}`);
      console.log(`FALHA a campanha de teste ${insert.data.id} ficou no banco - apague a mao`);
    } else {
      console.log("OK   campanha de verificacao removida");
    }
  }

  console.log(falhas.length === 0 ? "\nPostgREST enxerga as tres migrations." : "\nPENDENTE:\n  " + falhas.join("\n  "));

  if (falhas.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("FALHOU:", error.message);
  process.exitCode = 1;
});
