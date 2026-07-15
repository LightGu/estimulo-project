require("dotenv").config({ quiet: true });

const { createClient } = require("@supabase/supabase-js");
const { validateSupabaseEnv } = require("../config/supabase");

const globalKey = Symbol.for("estimulo-project.supabase-client");

function createSupabaseClient() {
  const { supabaseUrl, supabaseServiceRoleKey } = validateSupabaseEnv();

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function getSupabaseClient() {
  if (!globalThis[globalKey]) {
    globalThis[globalKey] = createSupabaseClient();
  }

  return globalThis[globalKey];
}

module.exports = getSupabaseClient();
