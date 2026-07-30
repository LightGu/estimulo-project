// Kill switch das notificacoes externas (mensagem real no grupo de avisos do
// WhatsApp). Existe por dois motivos:
//
// - A suite roda com `node tests/*.test.js`, sem NODE_ENV. Qualquer teste que
//   exercite um caminho de falha sem injetar um `notificationsService` falso cai
//   no servico real, que resolve o grupo salvo em `settings` e dispara mensagem
//   de verdade. Isso ja aconteceu: cada execucao da suite spamava o grupo com
//   "Falha simulada no envio", "Legenda reprovada: conteudo inventado" etc.
// - Da um dry-run operacional (NOTIFICATIONS_ENABLED=false) para investigar em
//   producao sem avisar o grupo.
//
// O padrao continua sendo notificar; so desligamos quando reconhecemos um
// contexto de teste ou quando a env pede explicitamente.

const TEST_ENTRYPOINT_PATTERN = /[\\/]tests?[\\/].+\.test\.js$/;

function parseBooleanEnv(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const normalized = value.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return null;
}

function isTestEnvironment(env = process.env, argv = process.argv) {
  if (env.NODE_ENV === "test") {
    return true;
  }

  // Definido pelo runner nativo (`node --test`).
  if (env.NODE_TEST_CONTEXT) {
    return true;
  }

  return TEST_ENTRYPOINT_PATTERN.test(argv[1] || "");
}

function areOutboundNotificationsEnabled(env = process.env, argv = process.argv) {
  const explicit = parseBooleanEnv(env.NOTIFICATIONS_ENABLED);

  if (explicit !== null) {
    return explicit;
  }

  return !isTestEnvironment(env, argv);
}

module.exports = {
  areOutboundNotificationsEnabled,
  isTestEnvironment,
  parseBooleanEnv,
};
