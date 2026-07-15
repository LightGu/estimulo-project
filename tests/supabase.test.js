const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadSupabaseEnv, validateSupabaseEnv } = require("../src/config/supabase");
const { runSupabaseConnectionCheck } = require("../scripts/test-supabase-connection");

function clearModuleCache() {
  delete require.cache[require.resolve("../src/config/supabase")];
  delete require.cache[require.resolve("../src/database/client")];
  delete require.cache[require.resolve("../scripts/test-supabase-connection")];
}

async function testEnvLoadsFromDotEnvFile() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "supabase-env-"));
  const envFilePath = path.join(tempDir, ".env");

  fs.writeFileSync(envFilePath, "SUPABASE_URL=https://example.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=service-role\n", "utf8");

  const env = {};
  const config = loadSupabaseEnv({ env, envFilePath });

  assert.equal(config.supabaseUrl, "https://example.supabase.co");
  assert.equal(config.supabaseServiceRoleKey, "service-role");
}

function testClientIsCreatedAsSingleton() {
  const originalEnv = { ...process.env };

  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";

  clearModuleCache();
  const firstClient = require("../src/database/client");
  clearModuleCache();
  const secondClient = require("../src/database/client");

  assert.ok(firstClient);
  assert.equal(firstClient, secondClient);

  process.env = originalEnv;
}

function testMissingSupabaseVariablesThrowClearError() {
  const originalEnv = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "supabase-empty-env-"));
  const envFilePath = path.join(tempDir, ".env");

  fs.writeFileSync(envFilePath, "", "utf8");
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  clearModuleCache();
  assert.throws(
    () => validateSupabaseEnv({ env: process.env, envFilePath }),
    /Missing environment variable: SUPABASE_URL/
  );

  process.env = originalEnv;
}

async function testConnectionCheckTreatsEmptyTableAsSuccess() {
  const fakeClient = {
    from(tableName) {
      assert.equal(tableName, "organizations");
      return {
        select() {
          return {
            limit() {
              return Promise.resolve({ data: [], error: null });
            },
          };
        },
      };
    },
  };

  const result = await runSupabaseConnectionCheck({ client: fakeClient });
  assert.equal(result.data.length, 0);
}

function testMigrationContainsRequiredSchemaPieces() {
  const migrationPath = path.join(process.cwd(), "supabase", "migrations", "202607140001_create_mvp_schema.sql");
  const migrationSql = fs.readFileSync(migrationPath, "utf8");

  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS public\.organizations/i);
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS public\.groups/i);
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS public\.campaigns/i);
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS public\.campaign_groups/i);
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS public\.video_catalog/i);
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS public\.group_video_progress/i);
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS public\.dispatch_logs/i);
  assert.match(migrationSql, /CREATE TRIGGER trg_organizations_updated_at/i);
  assert.match(migrationSql, /ALTER TABLE public\.organizations ENABLE ROW LEVEL SECURITY/i);
  assert.match(migrationSql, /CREATE POLICY/i);
}

function testMigrationIncludesConstraintsAndIndexes() {
  const migrationPath = path.join(process.cwd(), "supabase", "migrations", "202607140001_create_mvp_schema.sql");
  const migrationSql = fs.readFileSync(migrationPath, "utf8");

  assert.match(migrationSql, /CHECK \(maturidade BETWEEN 1 AND 4\)/i);
  assert.match(migrationSql, /CONSTRAINT chk_video_catalog_approval/i);
  assert.match(migrationSql, /REFERENCES public\.organizations\(id\)/i);
  assert.match(migrationSql, /UNIQUE \(group_id, video_id\)/i);
  assert.match(migrationSql, /CREATE INDEX IF NOT EXISTS idx_groups_organization_id/i);
}

async function main() {
  await testEnvLoadsFromDotEnvFile();
  testClientIsCreatedAsSingleton();
  testMissingSupabaseVariablesThrowClearError();
  await testConnectionCheckTreatsEmptyTableAsSuccess();
  testMigrationContainsRequiredSchemaPieces();
  testMigrationIncludesConstraintsAndIndexes();

  console.log("supabase tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
