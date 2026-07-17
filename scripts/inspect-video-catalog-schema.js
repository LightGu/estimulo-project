require("dotenv").config({ quiet: true });

const { Client } = require("pg");

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  try {
    const constraints = await client.query(`
      SELECT conname, pg_get_constraintdef(pg_constraint.oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'public.video_catalog'::regclass
      ORDER BY conname
    `);
    const columns = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'video_catalog'
      ORDER BY ordinal_position
    `);

    console.log(JSON.stringify({ columns: columns.rows, constraints: constraints.rows }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
