const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Regressao para o incidente de 04/09/2026 (21:13 e 21:45 UTC).
//
// A tela do Disparador Pontual oferecia "Capacitacao", mensagens.service.js
// aceitava "capacitacao", e a constraint CHECK de campaigns.classificacao nao
// conhecia esse valor. Como dispatchAdHoc envia ANTES de gravar a campanha
// ancora, o INSERT recusado nao virou erro na tela: virou
// `mensagens.persist_ad_hoc_campaign_failed` no log, com as mensagens ja
// entregues nos grupos e nenhuma linha em `logs`.
//
// Nenhum teste existente pegava isso: os mocks de Supabase usados em
// api.test.js e repositories.test.js aceitam qualquer valor, porque nao ha
// Postgres real na suite. Este teste ataca o problema por outro lado - le as
// TRES fontes de verdade como texto e exige que elas concordem. Assim, incluir
// uma classificacao nova sem migration (ou o inverso) falha aqui.

const ROOT = path.join(__dirname, "..");

function readMigrationConstraintValues() {
  const migrationsDir = path.join(ROOT, "supabase", "migrations");
  // A constraint pode ter sido recriada por uma migration posterior; vale a
  // ultima em ordem cronologica de nome de arquivo, que e' a ordem em que o
  // SQL Editor as aplica.
  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  let lastDefinition = null;

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    // Casa tanto "ADD COLUMN ... classificacao text CHECK (classificacao IN (...))"
    // quanto "ADD CONSTRAINT campaigns_classificacao_check CHECK (classificacao IN (...))".
    // O `[^)]*` evita cruzar o fecha-parenteses da lista.
    const matches = [...sql.matchAll(/classificacao\s+IN\s*\(([^)]*)\)/gi)];

    if (matches.length) {
      lastDefinition = { file, raw: matches[matches.length - 1][1] };
    }
  }

  assert.ok(lastDefinition, "nenhuma migration define a constraint de campaigns.classificacao");

  const values = lastDefinition.raw
    .split(",")
    .map((part) => part.trim().replace(/^'|'$/g, ""))
    .filter(Boolean);

  return { ...lastDefinition, values };
}

function readFrontendOptionValues() {
  const html = fs.readFileSync(path.join(ROOT, "public", "app", "mensagens.html"), "utf8");
  // O <select> de classificacao e' o #msgTipo; o valor escolhido vai para o
  // corpo do POST /mensagens/dispatch como `tipo`, que normalizeClassificacao le.
  const selectMatch = html.match(/<select[^>]*id="msgTipo"[^>]*>([\s\S]*?)<\/select>/i);

  assert.ok(selectMatch, "nao encontrei o <select> de classificacao em mensagens.html");

  return [...selectMatch[1].matchAll(/<option\s+value="([^"]*)"/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

const migration = readMigrationConstraintValues();
const { CLASSIFICACOES } = require("../src/services/mensagens.service");
const frontendValues = readFrontendOptionValues();

const sorted = (list) => [...list].sort();

// 1. Banco x service. Este e' exatamente o par que divergiu em producao: um
//    valor aceito pelo service e recusado pelo banco vira envio sem registro.
assert.deepEqual(
  sorted(migration.values),
  sorted(CLASSIFICACOES),
  `constraint CHECK de campaigns.classificacao (${migration.file}) divergiu de ` +
    `CLASSIFICACOES em src/services/mensagens.service.js.\n` +
    `  banco:   ${sorted(migration.values).join(", ")}\n` +
    `  service: ${sorted(CLASSIFICACOES).join(", ")}\n` +
    "Toda classificacao nova precisa de migration recriando a constraint."
);

// 2. Tela x service. O caminho inverso: uma opcao oferecida na tela que o
//    service nao reconhece cai em `null` por normalizeClassificacao, e o
//    usuario perde a classificacao que escolheu, sem aviso.
for (const value of frontendValues) {
  assert.ok(
    CLASSIFICACOES.includes(value),
    `mensagens.html oferece <option value="${value}"> que nao esta em CLASSIFICACOES ` +
      "(normalizeClassificacao devolveria null e a escolha do usuario seria descartada em silencio)"
  );
}

// 3. E o service nao deve aceitar valor que a tela nao ofereca, para a lista
//    nao acumular valores mortos que ninguem consegue selecionar.
for (const value of CLASSIFICACOES) {
  assert.ok(
    frontendValues.includes(value),
    `CLASSIFICACOES aceita "${value}" mas mensagens.html nao oferece essa opcao`
  );
}

// 4. Trava explicita do valor do incidente, para que uma futura reescritura
//    das listas nao o remova por descuido de novo.
assert.ok(
  migration.values.includes("capacitacao"),
  "a constraint precisa aceitar 'capacitacao' (incidente de 04/09/2026)"
);

console.log(
  `mensagens classificacao schema contract tests OK ` +
    `(${CLASSIFICACOES.length} classificacoes, constraint em ${migration.file})`
);
