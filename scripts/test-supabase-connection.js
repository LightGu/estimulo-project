const supabaseClient = require("../src/database/client");

async function runSupabaseConnectionCheck(options = {}) {
  const client = options.client || supabaseClient;

  const { data, error } = await client.from("organizations").select("id").limit(1);

  if (error) {
    throw error;
  }

  return {
    data,
    error: null,
  };
}

async function main() {
  try {
    const result = await runSupabaseConnectionCheck();

    if (result.data === undefined || result.data === null) {
      throw new Error("Unexpected response from Supabase");
    }

    console.log("Supabase connection OK");
    return 0;
  } catch (error) {
    const errorType = error?.name || "UnknownError";
    console.error(`Supabase connection failed: ${errorType}`);
    return 1;
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}

module.exports = {
  runSupabaseConnectionCheck,
};
