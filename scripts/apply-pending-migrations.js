/*
  Aplica as migrations pendentes de 202609 no Supabase, via pooler.

  POR QUE ESTE SCRIPT EXISTE.

  O projeto nao tem CLI do Supabase linkado e a rota documentada para migrations e
  colar o SQL no SQL Editor (ver o checklist de deploy). Este script nao substitui
  essa rota: ele existe porque o usuario pediu explicitamente que as migrations
  fossem aplicadas de uma vez, e faz isso pelo unico caminho de SQL cru que
  funciona hoje.

  A `DATABASE_URL` do .env esta morta - o host `db.<ref>.supabase.co` nao resolve
  em IPv4 nem IPv6. O que funciona e o pooler:

    host: aws-1-sa-east-1.pooler.supabase.com  (o prefixo aws-0 resolve em DNS
                                                mas responde "tenant not found")
    port: 5432                                 (session mode - o correto para DDL;
                                                transaction mode recusa
                                                CREATE INDEX CONCURRENTLY)
    user: postgres.<project ref>               (prefixo obrigatorio)

  MODO DE USO.

    node scripts/apply-pending-migrations.js --check    (so inspeciona, nao escreve)
    node scripts/apply-pending-migrations.js --apply    (aplica o que falta)

  O default e --check, para que rodar sem argumento nunca escreva no banco.

  CADA MIGRATION E IDEMPOTENTE E VERIFICADA ANTES E DEPOIS. O script:

    - checa o estado atual de cada objeto antes de mexer;
    - pula o que ja esta aplicado;
    - roda CREATE INDEX CONCURRENTLY fora de transacao (o Postgres proibe
      dentro), uma instrucao por vez;
    - diagnostica os duplicados ANTES de tentar criar o indice unico do trio, e
      se recusa a criar quando existem - o CREATE falharia no meio e deixaria um
      indice INVALID para trás.
*/
require("dotenv").config({ quiet: true });

const { Client } = require("pg");

function resolveConnectionSettings() {
  const raw = process.env.DATABASE_URL || "";
  const senhaMatch = raw.match(/postgres(?:\.[a-z0-9]+)?:([^@]*)@/);
  const refMatch = (process.env.SUPABASE_URL || "").match(/https:\/\/([a-z0-9]+)\.supabase\.co/);

  if (!senhaMatch || !refMatch) {
    throw new Error(
      "Nao consegui derivar a senha (de DATABASE_URL) e o project ref (de SUPABASE_URL) do .env"
    );
  }

  return {
    host: "aws-1-sa-east-1.pooler.supabase.com",
    port: 5432,
    user: `postgres.${refMatch[1]}`,
    password: decodeURIComponent(senhaMatch[1]),
    database: "postgres",
    ssl: { rejectUnauthorized: false },
    statement_timeout: 300000,
  };
}

async function withClient(callback) {
  const client = new Client(resolveConnectionSettings());

  await client.connect();

  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------- inspecao

async function inspect(client) {
  const { rows: constraint } = await client.query(`
    select pg_get_constraintdef(oid) as definicao
      from pg_constraint
     where conrelid = 'public.campaigns'::regclass
       and conname = 'campaigns_classificacao_check'
  `);

  const { rows: indices } = await client.query(`
    select indexname, indexdef, indisvalid
      from pg_indexes
      join pg_class on pg_class.relname = pg_indexes.indexname
      join pg_index on pg_index.indexrelid = pg_class.oid
     where schemaname = 'public'
       and tablename = 'logs'
       and indexname in ('idx_logs_trio_ativo', 'idx_logs_campaign_group_video_status')
  `);

  const { rows: coluna } = await client.query(`
    select data_type
      from information_schema.columns
     where table_schema = 'public' and table_name = 'logs' and column_name = 'dispatch_ref'
  `);

  const { rows: duplicados } = await client.query(`
    select campaign_id, group_id, video_id, count(*) as total
      from public.logs
     where status in ('pendente', 'processando', 'enviado')
     group by campaign_id, group_id, video_id
    having count(*) > 1
     order by count(*) desc
     limit 20
  `);

  return {
    classificacao: constraint[0] ? constraint[0].definicao : null,
    aceitaCapacitacao: Boolean(constraint[0] && constraint[0].definicao.includes("capacitacao")),
    indices,
    temDispatchRef: coluna.length > 0,
    duplicados,
  };
}

function report(estado) {
  console.log("\n--- estado atual ---");
  console.log("campaigns_classificacao_check:", estado.classificacao || "(constraint ausente)");
  console.log("  aceita 'capacitacao'?", estado.aceitaCapacitacao ? "SIM" : "NAO");
  console.log("logs.dispatch_ref existe?", estado.temDispatchRef ? "SIM" : "NAO");
  console.log(
    "indices do trio:",
    estado.indices.length
      ? estado.indices.map((i) => `${i.indexname}${i.indisvalid ? "" : " (INVALID!)"}`).join(", ")
      : "(nenhum)"
  );
  console.log(
    "trios duplicados em status ativo:",
    estado.duplicados.length === 0 ? "nenhum" : `${estado.duplicados.length} (impede o indice unico)`
  );

  for (const linha of estado.duplicados) {
    console.log(
      `  campaign=${linha.campaign_id} group=${linha.group_id} video=${linha.video_id} -> ${linha.total} linhas`
    );
  }
}

// ---------------------------------------------------------------- aplicacao

async function applyClassificacao(client, estado) {
  if (estado.aceitaCapacitacao) {
    console.log("\n[1/3] 202609070001 - constraint de classificacao: JA APLICADA, pulando");
    return { aplicada: false };
  }

  console.log("\n[1/3] 202609070001 - recriando campaigns_classificacao_check com 'capacitacao'");

  // Uma transacao: entre o DROP e o ADD a tabela fica sem a checagem, e um
  // insert concorrente com valor invalido passaria.
  await client.query("begin");

  try {
    await client.query("alter table public.campaigns drop constraint if exists campaigns_classificacao_check");
    await client.query(`
      alter table public.campaigns
        add constraint campaigns_classificacao_check
        check (classificacao in ('evento', 'credito', 'pesquisa', 'aviso', 'capacitacao', 'outro'))
    `);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }

  console.log("      OK");

  return { aplicada: true };
}

async function applyTrioIndexes(client, estado) {
  const existente = new Map(estado.indices.map((i) => [i.indexname, i]));

  // Indice INVALID e' resto de um CREATE CONCURRENTLY interrompido: ele nao
  // impede escrita, mas tambem nao serve de nada e faz o IF NOT EXISTS
  // seguinte achar que o trabalho ja foi feito. Precisa sair antes.
  for (const indice of estado.indices) {
    if (!indice.indisvalid) {
      console.log(`\n[2/3] removendo indice INVALID remanescente: ${indice.indexname}`);
      await client.query(`drop index concurrently if exists public.${indice.indexname}`);
      existente.delete(indice.indexname);
    }
  }

  if (existente.has("idx_logs_trio_ativo")) {
    console.log("\n[2/3] 202609070002 - idx_logs_trio_ativo: JA APLICADO, pulando");
  } else if (estado.duplicados.length > 0) {
    console.log(
      `\n[2/3] 202609070002 - RECUSADO: existem ${estado.duplicados.length} trios duplicados em status ativo.`
    );
    console.log("      Criar o indice unico agora falharia no meio e deixaria um indice INVALID.");
    console.log("      Resolva os duplicados listados acima primeiro (decisao de dados, nao de schema).");

    return { indiceUnico: false, indiceComposto: false, bloqueado: true };
  } else {
    console.log("\n[2/3] 202609070002 - criando idx_logs_trio_ativo (CONCURRENTLY, fora de transacao)");
    // CONCURRENTLY nao pode rodar dentro de transacao - por isso uma instrucao
    // por chamada, sem begin/commit em volta.
    await client.query(`
      create unique index concurrently if not exists idx_logs_trio_ativo
        on public.logs (campaign_id, group_id, video_id)
        where status in ('pendente', 'processando', 'enviado')
    `);
    console.log("      OK");
  }

  if (existente.has("idx_logs_campaign_group_video_status")) {
    console.log("      idx_logs_campaign_group_video_status: JA APLICADO, pulando");
  } else {
    console.log("      criando idx_logs_campaign_group_video_status (CONCURRENTLY)");
    await client.query(`
      create index concurrently if not exists idx_logs_campaign_group_video_status
        on public.logs (campaign_id, group_id, video_id, status)
    `);
    console.log("      OK");
  }

  return { bloqueado: false };
}

async function applyDispatchRef(client, estado) {
  if (estado.temDispatchRef) {
    console.log("\n[3/3] 202609070003 - logs.dispatch_ref: JA APLICADA, pulando");
    return { aplicada: false };
  }

  console.log("\n[3/3] 202609070003 - adicionando logs.dispatch_ref");

  await client.query("alter table public.logs add column if not exists dispatch_ref text");
  await client.query(`
    comment on column public.logs.dispatch_ref is
      'Identificador de correlacao do envio (d:<campanha>:<grupo>:<video>), propagado por todas as camadas. Ver src/utils/dispatch-ref.js.'
  `);
  await client.query(`
    create index concurrently if not exists idx_logs_dispatch_ref
      on public.logs (dispatch_ref)
      where dispatch_ref is not null
  `);

  console.log("      OK");

  return { aplicada: true };
}

// ---------------------------------------------------------------- entrada

async function main() {
  const apply = process.argv.includes("--apply");
  const settings = resolveConnectionSettings();

  console.log(`Conectando em ${settings.host}:${settings.port} como ${settings.user}`);
  console.log(apply ? "MODO: --apply (vai escrever no banco)" : "MODO: --check (somente leitura)");

  await withClient(async (client) => {
    const antes = await inspect(client);
    report(antes);

    if (!apply) {
      console.log("\nNada foi alterado. Rode com --apply para aplicar o que falta.");
      return;
    }

    await applyClassificacao(client, antes);
    const trio = await applyTrioIndexes(client, antes);
    await applyDispatchRef(client, antes);

    const depois = await inspect(client);
    console.log("\n=== VERIFICACAO POS-APLICACAO ===");
    report(depois);

    const pendencias = [];

    if (!depois.aceitaCapacitacao) pendencias.push("constraint de classificacao nao aceita 'capacitacao'");
    if (!depois.temDispatchRef) pendencias.push("logs.dispatch_ref ausente");

    const trioAtivo = depois.indices.find((i) => i.indexname === "idx_logs_trio_ativo");
    if (!trioAtivo) {
      pendencias.push(
        trio.bloqueado ? "idx_logs_trio_ativo bloqueado por duplicados pre-existentes" : "idx_logs_trio_ativo ausente"
      );
    } else if (!trioAtivo.indisvalid) {
      pendencias.push("idx_logs_trio_ativo ficou INVALID");
    }

    if (pendencias.length) {
      console.log("\nPENDENTE:");
      pendencias.forEach((p) => console.log("  - " + p));
      process.exitCode = 1;
    } else {
      console.log("\nTodas as tres migrations estao aplicadas e validas.");
    }
  });
}

main().catch((error) => {
  console.error("\nFALHOU:", error.message);
  if (error.code) console.error("codigo:", error.code);
  process.exitCode = 1;
});
