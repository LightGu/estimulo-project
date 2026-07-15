require("dotenv").config({ quiet: true });

function resolveSupabaseEnv(env = process.env) {
  const sourceEnv = env || process.env;

  return {
    supabaseUrl: sourceEnv.SUPABASE_URL,
    supabaseAnonKey: sourceEnv.SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: sourceEnv.SUPABASE_SERVICE_ROLE_KEY,
  };
}

function loadSupabaseEnv(options = {}) {
  const { env = process.env, envFilePath } = options;
  const baseEnv = env === undefined ? process.env : env;
  const mergedEnv = { ...(baseEnv || {}) };

  if (envFilePath) {
    const envFileContent = require("dotenv").parse(require("node:fs").readFileSync(envFilePath, "utf8"));
    Object.assign(mergedEnv, envFileContent);
  }

  return resolveSupabaseEnv(mergedEnv);
}

function validateSupabaseEnv(options = {}) {
  const { env = process.env, envFilePath } = options;
  const { supabaseUrl, supabaseServiceRoleKey } = loadSupabaseEnv({ env, envFilePath });

  if (!supabaseUrl) {
    throw new Error("Missing environment variable: SUPABASE_URL");
  }

  if (!supabaseServiceRoleKey) {
    throw new Error("Missing environment variable: SUPABASE_SERVICE_ROLE_KEY");
  }

  return {
    supabaseUrl,
    supabaseServiceRoleKey,
  };
}

module.exports = {
  loadSupabaseEnv,
  validateSupabaseEnv,
};
