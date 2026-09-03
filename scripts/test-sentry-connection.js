const { Sentry, enabled, initSentry } = require("../src/config/sentry");

async function runSentryConnectionCheck() {
  if (!enabled) {
    throw new Error("SENTRY_DSN nao configurado (ou NODE_ENV=test) - preencha .env antes de testar");
  }

  initSentry({ serverName: "test-sentry-connection" });

  Sentry.captureException(new Error("Teste de conexao do Estimulo com o Sentry"), {
    tags: { test: true },
  });

  const delivered = await Sentry.flush(5000);

  if (!delivered) {
    throw new Error("Timeout aguardando confirmacao de envio do evento ao Sentry");
  }
}

async function main() {
  try {
    await runSentryConnectionCheck();
    console.log("Sentry connection OK - evento de teste enviado. Confira em Issues no sentry.io.");
    return 0;
  } catch (error) {
    console.error(`Sentry connection failed: ${error.message}`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  runSentryConnectionCheck,
};
