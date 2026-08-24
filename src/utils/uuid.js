/*
  Reconhecimento de UUID canonico (versoes 1-5, variante RFC 4122).

  A mesma regex estava duplicada byte a byte em queues/dispatch.js e
  queues/campaign-trigger.js. Nao e' cosmetico: em dispatch.js ela decide se o
  caminho de dispatch-consistency e' usado (canUseDispatchConsistency), que e'
  o que protege contra envio duplicado. Duas copias significam que endurecer a
  validacao num arquivo e esquecer o outro passa despercebido.
*/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return UUID_PATTERN.test(String(value || ""));
}

module.exports = { UUID_PATTERN, isUuid };
