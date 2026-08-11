require("dotenv").config({ quiet: true });

const { clearLoopbackDiscardProxyEnv } = require("../src/config/network");
clearLoopbackDiscardProxyEnv(process.env, { logger: console });

const createApp = require("../src/api/app");
const whatsappInstancesService = require("../src/services/whatsapp-instances.service");

const port = Number(process.env.PORT || 3000);
const app = createApp();

whatsappInstancesService.ensureLegacyInstanceRegistered().catch((error) => {
  console.error("Falha ao registrar instancia legada da Evolution API:", error.message);
});

const server = app.listen(port, () => {
  console.log(`API local iniciada em http://127.0.0.1:${port}`);
  console.log(`Aplicacao web: http://127.0.0.1:${port}/app/index.html`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Porta ${port} ja esta em uso por outro processo. Feche-o (ou finalize o node.exe pendente) e tente novamente.`
    );
    process.exit(1);
    return;
  }

  console.error("Falha ao iniciar o servidor:", error.message);
  process.exit(1);
});

// A geracao de legendas de um disparo roda em background dentro deste processo
// (dispatchCampaign inicia e nao aguarda). Sem estes handlers, qualquer excecao
// ou rejeicao solta nesse trabalho - ou em qualquer EventEmitter de terceiros -
// derrubava o `npm run api` no meio do caminho: a tela continuava em
// "Processando" para sempre e toda requisicao seguinte, inclusive o DELETE que
// cancela o disparo, falhava com "Failed to fetch". Registrar e seguir servindo
// mantem o operador no controle: da para cancelar o disparo, corrigir a causa e
// tentar de novo em vez de descobrir o problema por um servidor morto.
function logProcessFailure(event, error) {
  console.error(
    JSON.stringify({
      event,
      error_message: (error && error.message) || String(error),
      stack: error && error.stack,
    })
  );
}

process.on("unhandledRejection", (reason) => {
  logProcessFailure("api.unhandled_rejection", reason);
});

process.on("uncaughtException", (error) => {
  logProcessFailure("api.uncaught_exception", error);
});

async function shutdown() {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});

process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});
