require("dotenv").config({ quiet: true });

const Sentry = require("@sentry/node");

// Central de configuracao/inicializacao do Sentry no backend (API + workers
// BullMQ). Sem SENTRY_DSN definido (ou em teste), fica completamente desligado
// - nenhum evento sai do processo e nenhuma chamada de rede e feita, entao
// rodar sem configurar Sentry (dev local, CI) segue funcionando exatamente
// como antes.
const dsn = process.env.SENTRY_DSN || "";
const environment = process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development";
const isTestRun = process.env.NODE_ENV === "test";
const enabled = Boolean(dsn) && !isTestRun;

const tracesSampleRate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0);

let initialized = false;

// Chamada uma vez, o mais cedo possivel em cada entrypoint (scripts/start-*.js),
// antes de outros requires - e' o que permite a instrumentacao automatica do
// Sentry (http, etc). Idempotente: seguro chamar de novo se algum modulo
// importar este arquivo mais de uma vez.
function initSentry(options = {}) {
  if (!enabled || initialized) return;

  Sentry.init({
    dsn,
    environment,
    tracesSampleRate,
    serverName: options.serverName,
  });

  initialized = true;
}

module.exports = {
  Sentry,
  enabled,
  environment,
  initSentry,
};
