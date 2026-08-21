// Trava de seguranca contra disparo tardio: se um job de envio so roda muito
// depois do horario_envio_planejado (fila que ficou parada, worker que caiu e
// voltou, resume de uma campanha pausada ha muito tempo), o destinatario nao
// pode receber uma mensagem "atrasada" sem contexto - o correto e cancelar e
// deixar claro no relatorio, nunca disparar por cima de um horario que ja
// passou ha muito tempo.

const DEFAULT_MAX_DISPATCH_DELAY_MS = 30 * 60 * 1000;

function resolveMaxDispatchDelayMs() {
  const configured = Number(process.env.MAX_DISPATCH_DELAY_MS);

  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_MAX_DISPATCH_DELAY_MS;
  }

  return Math.trunc(configured);
}

// Retorna null quando o job ainda pode ser enviado, ou um motivo (string)
// quando o atraso ja estourou o teto e o job deve ser cancelado sem enviar.
function resolveStaleDispatchReason(scheduledAt, options = {}) {
  const { maxDelayMs = resolveMaxDispatchDelayMs(), now = () => new Date() } = options;

  if (!scheduledAt) {
    return null;
  }

  const scheduledTime = new Date(scheduledAt).getTime();

  if (Number.isNaN(scheduledTime)) {
    return null;
  }

  const delayMs = now().getTime() - scheduledTime;

  if (delayMs <= maxDelayMs) {
    return null;
  }

  const delayMinutes = Math.floor(delayMs / 60000);

  return (
    `Envio cancelado: horario planejado (${new Date(scheduledTime).toISOString()}) ultrapassou ` +
    `${Math.floor(maxDelayMs / 60000)} min de atraso (atraso de ${delayMinutes} min).`
  );
}

module.exports = {
  DEFAULT_MAX_DISPATCH_DELAY_MS,
  resolveMaxDispatchDelayMs,
  resolveStaleDispatchReason,
};
