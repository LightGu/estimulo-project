/*
  Lista as colunas de uma tabela do Supabase, pelo pooler.

  Existe porque adivinhar nome de coluna foi a origem de mais de um erro neste
  projeto (`description` vs `descricao` em organizations; `nome`/`criado_em` que
  campaigns nao tem). Uso:

    node scripts/inspect-schema-columns.js campaigns logs
*/
require("dotenv").config({ quiet: true });

const { Client } = require("pg");

function resolveConnectionSettings() {
  const raw = process.env.DATABASE_URL || "";
  const senhaMatch = raw.match(/postgres(?:\.[a-z0-9]+)?:([^@]*)@/);
  const refMatch = (process.env.SUPABASE_URL || "").match(/https:\/\/([a-z0-9]+)\.supabase\.co/);

  if (!senhaMatch || !refMatch) {
    throw new Error("Nao consegui derivar senha/project ref do .env");
  }

  return {
    host: "aws-1-sa-east-1.pooler.supabase.com",
    port: 5432,
    user: `postgres.${refMatch[1]}`,
    password: decodeURIComponent(senhaMatch[1]),
    database: "postgres",
    ssl: { rejectUnauthorized: false },
    statement_timeout: 30000,
  };
}

async function main() {
  const tabelas = process.argv.slice(2);

  if (tabelas.length === 0) {
    console.error("uso: node scripts/inspect-schema-columns.js <tabela> [tabela...]");
    process.exitCode = 1;
    return;
  }

  const client = new Client(resolveConnectionSettings());
  await client.connect();

  try {
    for (const tabela of tabelas) {
      const { rows } = await client.query(
        `select column_name, data_type, is_nullable, column_default
           from information_schema.columns
          where table_schema = 'public' and table_name = $1
          order by ordinal_position`,
        [tabela]
      );

      console.log(`\n=== public.${tabela} (${rows.length} colunas) ===`);

      for (const coluna of rows) {
        const obrigatoria = coluna.is_nullable === "NO" && !coluna.column_default ? "  <- NOT NULL sem default" : "";
        const padrao = coluna.column_default ? ` default ${String(coluna.column_default).slice(0, 40)}` : "";
        console.log(`  ${coluna.column_name} : ${coluna.data_type}${padrao}${obrigatoria}`);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("FALHOU:", error.message);
  process.exitCode = 1;
});
