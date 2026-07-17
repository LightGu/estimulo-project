const fs = require("node:fs");
const path = require("node:path");

require("dotenv").config({ quiet: true });

const { Client } = require("pg");

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL nao definido");
  }

  const migrationPath = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : path.resolve(__dirname, "../supabase/migrations/202607160001_update_video_catalog_drive_metadata.sql");
  const sql = fs.readFileSync(migrationPath, "utf8");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  try {
    await client.query(sql);
    console.log(`migration applied: ${path.relative(process.cwd(), migrationPath)}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
