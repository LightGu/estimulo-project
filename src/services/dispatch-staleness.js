// Trava de seguranca contra disparo tardio: se um job de envio so roda muito
// depois do horario_envio_planejado (fila que ficou parada, worker que caiu e
// voltou, resume de uma campanha pausada ha muito tempo), o destinatario nao
// pode receber uma mensagem "atrasada" sem contexto - o correto e cancelar e
// deixar claro no relatorio, nunca disparar por cima de um horario que ja
// passou ha muito tempo.

const DEFAULT_MAX_DISPATCH_DELAY_MS = 30 * 60 * 1000;

// Teto separado (e bem mais generoso) para a fila de VIDEO.
//
// Por que nao reusar os 30 min do envio pontual: o worker de video roda com
// concorrencia 1 e cada job baixa o arquivo do Drive, normaliza o container e
// comprime (DISPATCH_JOB_TIMEOUT_MS admite 25 min por job). Numa campanha com
// muitos grupos o processamento e serial, entao os ultimos grupos acumulam
// atraso em relacao ao proprio horario sorteado - com teto de 30 min, envios
// legitimos seriam cancelados e a campanha entregaria so os primeiros grupos.
// Trocar spam por sub-entrega silenciosa nao resolve nada.
//
// 6 horas cobre com folga a janela de uma campanha de um dia e continua barrando
// por ordem de grandeza o caso que gerou o incidente: job de DIAS atras
// promovido de uma vez quando a infra do Docker sobe.
const DEFAULT_MAX_VIDEO_DISPATCH_DELAY_MS = 6 * 60 * 60 * 1000;

// Teto ABSOLUTO, valido inclusive dentro da janela escolhida pelo usuario.
//
// Existe porque a regra da janela (abaixo) desarma o teto normal enquanto o
// horario de fim nao chegou, e uma janela mal preenchida (fim daqui a uma
// semana) reabriria exatamente a porta que a trava fechou: job de dias atras
// promovido de uma vez quando a infra do Docker sobe. 24h e' maior que qualquer
// janela legitima de um disparo e menor, por ordem de grandeza, que o replay de
// boot que gerou o incidente.
const DEFAULT_MAX_ABSOLUTE_DISPATCH_DELAY_MS = 24 * 60 * 60 * 1000;

function resolvePositiveEnvMs(name, fallbackMs) {
  const configured = Number(process.env[name]);

  if (!Number.isFinite(configured) || configured <= 0) {
    return fallbackMs;
  }

  return Math.trunc(configured);
}

function resolveMaxDispatchDelayMs() {
  return resolvePositiveEnvMs("MAX_DISPATCH_DELAY_MS", DEFAULT_MAX_DISPATCH_DELAY_MS);
}

function resolveMaxVideoDispatchDelayMs() {
  return resolvePositiveEnvMs("MAX_VIDEO_DISPATCH_DELAY_MS", DEFAULT_MAX_VIDEO_DISPATCH_DELAY_MS);
}

function resolveMaxAbsoluteDispatchDelayMs() {
  return resolvePositiveEnvMs("MAX_ABSOLUTE_DISPATCH_DELAY_MS", DEFAULT_MAX_ABSOLUTE_DISPATCH_DELAY_MS);
}

// Retorna null quando o job ainda pode ser enviado, ou um motivo (string)
// quando o atraso ja estourou o teto e o job deve ser cancelado sem enviar.
//
// Tolera horario ausente (retorna null = "segue o fluxo") porque ha logs de
// disparo legitimamente sem horario_envio_planejado: envio imediato e disparo
// de teste criam o log na hora do envio. Para a checagem no nivel do JOB, onde
// o horario e sempre preenchido, use resolveJobStaleReason - que falha fechado.
function resolveStaleDispatchReason(scheduledAt, options = {}) {
  const {
    maxDelayMs = resolveMaxDispatchDelayMs(),
    now = () => new Date(),
    windowEnd,
    maxAbsoluteDelayMs = resolveMaxAbsoluteDispatchDelayMs(),
  } = options;

  if (!scheduledAt) {
    return null;
  }

  const scheduledTime = new Date(scheduledAt).getTime();

  if (Number.isNaN(scheduledTime)) {
    return null;
  }

  const nowMs = now().getTime();
  const delayMs = nowMs - scheduledTime;

  if (delayMs <= maxDelayMs) {
    return null;
  }

  // O teto de atraso estourou, mas isso sozinho nao distingue os dois casos
  // OPOSTOS que chegam aqui:
  //
  //   (a) job zumbi: agendado ha dias, promovido de uma vez pela BullMQ quando
  //       a infra sobe - o caso que gerou spam real e que a trava existe para
  //       barrar;
  //   (b) job legitimo do disparo que o usuario acabou de criar, que so nao
  //       rodou no horario porque a fila ficou parada (worker caido/reiniciado,
  //       backlog). Cancelar este ultimo transformava um atraso operacional em
  //       envio perdido, sem que ninguem tivesse pedido - e era o que o operador
  //       via como "o sistema cancelou sozinho".
  //
  // A janela de envio escolhida pelo usuario e' que separa os dois: enquanto o
  // horario de FIM nao chegou, entregar continua sendo exatamente o que foi
  // pedido, atrasado ou nao. Passou do fim, nao ha mais envio a fazer.
  // O teto absoluto continua valendo por cima, para uma janela mal preenchida
  // nao reabrir o caso (a).
  const windowEndTime = windowEnd ? new Date(windowEnd).getTime() : NaN;
  const dentroDaJanela = Number.isFinite(windowEndTime) && nowMs <= windowEndTime;

  if (dentroDaJanela && delayMs <= maxAbsoluteDelayMs) {
    return null;
  }

  const delayMinutes = Math.floor(delayMs / 60000);

  if (Number.isFinite(windowEndTime) && nowMs > windowEndTime) {
    return (
      `Envio cancelado: a janela de envio terminou em ${new Date(windowEndTime).toISOString()} ` +
      `e o horario planejado (${new Date(scheduledTime).toISOString()}) acumulou ` +
      `${delayMinutes} min de atraso.`
    );
  }

  return (
    `Envio cancelado: horario planejado (${new Date(scheduledTime).toISOString()}) ultrapassou ` +
    `${Math.floor(maxDelayMs / 60000)} min de atraso (atraso de ${delayMinutes} min).`
  );
}

// Versao FALHA-FECHADO da trava de atraso, para usar na entrada dos workers de
// envio (queues/dispatch.js e queues/mensagens-dispatch.js).
//
// A diferenca importa: todo job dessas duas filas nasce com scheduled_at
// preenchido (buildDispatchJobData e buildMensagensJobData normalizam o campo,
// com fallback para "agora"), entao um job SEM horario nesse ponto e um job
// corrompido/legado - e a resposta segura para "nao sei quando isto deveria ter
// saido" e nao enviar, nunca enviar.
//
// Isto e o que impede o cenario que gerou spam real: o Redis da infra persiste
// os jobs (`--appendonly yes` + volume), e a cada `docker compose up` a BullMQ
// promove de uma vez tudo que estava `delayed` com horario vencido e reentrega o
// que ficou `active` no shutdown. Sem uma trava na entrada do worker, cada boot
// reenviava para os grupos mensagens agendadas dias antes.
function resolveJobStaleReason(scheduledAt, options = {}) {
  const { maxDelayMs = resolveMaxDispatchDelayMs(), now = () => new Date() } = options;

  if (!scheduledAt) {
    return "Envio cancelado: job sem horario planejado (scheduled_at ausente), impossivel validar o atraso.";
  }

  const scheduledTime = new Date(scheduledAt).getTime();

  if (Number.isNaN(scheduledTime)) {
    return `Envio cancelado: job com horario planejado invalido (${String(scheduledAt)}).`;
  }

  // ...options preserva windowEnd/maxAbsoluteDelayMs para a regra de janela.
  return resolveStaleDispatchReason(scheduledAt, { ...options, maxDelayMs, now });
}

// Horario original de um log de disparo, para reenfileirar o envio SEM apagar a
// evidencia de atraso. Retorna null quando nao ha nada em que ancorar.
//
// Existe porque buildDispatchJobData/buildMensagensJobData normalizam
// scheduled_at com `= new Date()` como valor default do parametro: quem
// reenfileira passando um horario nulo recebe "agora" de volta, e o job antigo
// volta para a fila parecendo recem-agendado - exatamente o que fazia a trava de
// atraso autorizar um envio de dias atras. Todo caminho de requeue deve resolver
// o horario por aqui e PULAR o log quando o retorno for null, em vez de deixar o
// default assumir.
//
// createAttemptLog historicamente criava log sem horario_envio_planejado, por
// isso o fallback para criado_em.
function resolveLogScheduledAt(log = {}) {
  return log.horario_envio_planejado || log.criado_em || null;
}

// Motivo de bloqueio quando a campanha nao esta mais em um estado que autoriza
// envio. Pausa e cancelamento nao mexem no job que ja esta no Redis, entao esta
// checagem e a unica coisa entre um job sobrevivente e uma mensagem indevida.
function resolveCampaignBlockReason(campaign) {
  if (!campaign) {
    return null;
  }

  if (campaign.status === "cancelado") {
    return "Envio cancelado: campanha foi cancelada.";
  }

  if (campaign.status === "pausado") {
    return "Envio adiado: campanha esta pausada.";
  }

  return null;
}

module.exports = {
  DEFAULT_MAX_ABSOLUTE_DISPATCH_DELAY_MS,
  DEFAULT_MAX_DISPATCH_DELAY_MS,
  DEFAULT_MAX_VIDEO_DISPATCH_DELAY_MS,
  resolveCampaignBlockReason,
  resolveJobStaleReason,
  resolveLogScheduledAt,
  resolveMaxAbsoluteDispatchDelayMs,
  resolveMaxDispatchDelayMs,
  resolveMaxVideoDispatchDelayMs,
  resolveStaleDispatchReason,
};
