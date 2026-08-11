// Confirmacao de entrega compartilhada entre os caminhos de envio.
//
// Sao duas checagens distintas, nesta ordem:
//
// 1. `assertDeliveryConfirmed` - a Evolution API responde HTTP 200 mesmo quando
//    recusa (corpo com `error`, `success: false` ou `status: "erro"`). Isso pega
//    a recusa explicita.
//
// 2. `confirmProviderDelivery` - o aceite da Evolution NAO e entrega. Ela grava
//    a mensagem com status PENDING e so troca para SERVER_ACK/DELIVERY_ACK/READ
//    quando o WhatsApp confirma. Enquanto o log era marcado "enviado" so por o
//    passo 1 ter passado, o relatorio afirmava entrega sem nenhum lastro - e na
//    instancia real havia centenas de mensagens de grupo paradas em PENDING,
//    todas registradas como "enviado". Este passo le o ACK e grava o que
//    encontrou.
//
// IMPORTANTE - por que a ausencia de ACK nao reprova envio para grupo:
// o WhatsApp nao devolve ACK por mensagem que a gente manda em grupo. Medido no
// banco da instancia real: as 18 mensagens enviadas pela API para `@g.us`
// (`source='web'`) ficaram em `PENDING` indefinidamente e nenhuma gerou linha em
// `MessageUpdate`; as 352 linhas de ACK que existem (270 DELIVERY_ACK, 82 READ,
// 10 PLAYED) eram todas de conversa fora de grupo. Ou seja: para grupo nao existe
// sinal de ACK a ser esperado. Tratar a falta dele como falha reprovava 100% dos
// disparos de campanha - vidoes que chegaram ao grupo apareciam como "Falhou",
// cada um gerava notificacao de falha, e o sweep de reprocessamento reenviava o
// mesmo video. Trocar uma mentira ("entregue" sem lastro) por outra ("falhou" com
// a mensagem no grupo) nao e conserto.
//
// Logo: para destino de grupo, sem ACK o envio segue como enviado e o log guarda
// SEM_ACK_DE_GRUPO, que o relatorio mostra como selo de confirmacao proprio -
// distinto de entrega confirmada e distinto de falha. Recusa explicita (passo 1) e
// ACK de erro (ERROR/SERVER_ERROR) continuam reprovando, em grupo ou fora dele.
//
// Manter as duas regras em um unico lugar evita que os caminhos de video e de
// mensagem pontual divirjam de novo.

const { deliveryConfirmationConfig } = require("../config/evolution");
const defaultMessageStatusReader = require("./evolution-message-status");

// ACKs do WhatsApp que significam "saiu daqui e o servidor confirmou".
const CONFIRMED_ACK_STATUSES = new Set(["SERVER_ACK", "DELIVERY_ACK", "READ", "PLAYED"]);
// Estado inicial de todo envio aceito. Nao e falha por si so - vira falha
// apenas quando persiste ate o fim da janela de espera.
const PENDING_ACK_STATUSES = new Set(["PENDING"]);
const FAILED_ACK_STATUSES = new Set(["ERROR", "SERVER_ERROR"]);

// Gravado em `logs.provider_status` quando nao foi possivel consultar o ACK.
// Deliberadamente diferente de "PENDING": distingue "o WhatsApp nao confirmou"
// de "nao conseguimos perguntar", e o relatorio mostra os dois de formas
// diferentes.
const UNVERIFIED_PROVIDER_STATUS = "NAO_VERIFICADO";
// Gravado quando a consulta funcionou e a resposta foi "nao existe ACK para esta
// mensagem de grupo" - o caso normal, nao um problema. Terceiro estado proprio
// justamente para o relatorio nao ter de escolher entre chamar isso de entrega
// confirmada ou de falha.
const GROUP_UNCONFIRMED_PROVIDER_STATUS = "SEM_ACK_DE_GRUPO";
const GROUP_JID_SUFFIX = "@g.us";

function isGroupJid(remoteJid) {
  return String(remoteJid || "").trim().toLowerCase().endsWith(GROUP_JID_SUFFIX);
}

function isFailureLikeStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();

  return ["error", "erro", "failed", "failure", "false", "500", "400"].includes(normalized);
}

function assertDeliveryConfirmed(result) {
  if (!result) {
    throw new Error("Envio nao confirmado pelo provedor");
  }

  if (result.status !== undefined && (Number(result.status) < 200 || Number(result.status) >= 300)) {
    throw new Error(`Envio nao confirmado pelo provedor: status ${result.status}`);
  }

  const data = result.data || {};

  if (result.error || data.error || data.errors || data.success === false || isFailureLikeStatus(data.status)) {
    const message =
      result.error?.message ||
      data.error?.message ||
      data.message ||
      data.response?.message ||
      "Envio nao confirmado pelo provedor";

    throw new Error(message);
  }
}

// O que a Evolution devolve num envio aceito: `data.key.id` (id da mensagem no
// WhatsApp) e `data.status`, que no aceite e "PENDING". Quando
// `confirmProviderDelivery` ja rodou, o ACK real fica em
// `result.delivery_confirmation` e tem prioridade sobre o status do aceite -
// sem isso o log guardaria "PENDING" mesmo depois de o WhatsApp ter confirmado.
function extractProviderDelivery(result) {
  const data = (result && result.data) || {};
  const key = data.key || {};
  const messageId = key.id || data.id || null;
  const confirmation = result && result.delivery_confirmation;

  if (confirmation) {
    return {
      provider_message_id: confirmation.provider_message_id || (messageId ? String(messageId) : null),
      provider_status: confirmation.provider_status || null,
    };
  }

  return {
    provider_message_id: messageId ? String(messageId) : null,
    provider_status: data.status === undefined || data.status === null ? null : String(data.status),
  };
}

// O nome da instancia nao vem no corpo da resposta, mas o endpoint chamado e
// `/message/sendMedia/<instancia>` - basta ler o ultimo segmento.
function extractInstanceNameFromEndpoint(endpoint) {
  if (!endpoint) {
    return null;
  }

  const segments = String(endpoint).split("/").filter(Boolean);

  return segments.length ? segments[segments.length - 1] : null;
}

function classifyProviderAck(status) {
  const normalized = String(status || "").trim().toUpperCase();

  if (!normalized) {
    return "desconhecido";
  }

  if (CONFIRMED_ACK_STATUSES.has(normalized)) {
    return "confirmado";
  }

  if (PENDING_ACK_STATUSES.has(normalized)) {
    return "aguardando";
  }

  if (FAILED_ACK_STATUSES.has(normalized)) {
    return "falhou";
  }

  return "desconhecido";
}

function buildNotConfirmedError(providerStatus, waitedMs) {
  const seconds = Math.round(waitedMs / 1000);
  const detail = providerStatus ? ` (estado no provedor: ${providerStatus})` : "";
  // A primeira frase e o que `dispatch-failure-retry` casa para classificar esta
  // falha como permanente (a mensagem ja saiu, reenviar duplicaria) - mudar o
  // texto dela exige mudar PERMANENT_FAILURE_PATTERNS junto.
  const error = new Error(
    `Envio aceito pela Evolution, mas o WhatsApp nao confirmou a entrega em ${seconds}s${detail}. ` +
      "Verifique a conexao do numero em Configuracoes > WhatsApp."
  );

  error.code = "DELIVERY_NOT_CONFIRMED";
  error.providerStatus = providerStatus || null;

  return error;
}

function defaultWait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logConfirmationEvent(logger, level, event, payload) {
  const writer = logger && (logger[level] || logger.info);

  if (typeof writer !== "function") {
    return;
  }

  writer.call(logger, JSON.stringify({ event, ...payload }));
}

// Le o ACK do WhatsApp para a mensagem que a Evolution acabou de aceitar.
//
// Retorna a evidencia a ser gravada no log. Lanca em dois casos, e so nesses:
// o provedor marcou a mensagem com ACK de erro, ou o destino nao e grupo e o ACK
// nao chegou dentro da janela. Fora de grupo o ACK e confiavel, entao a ausencia
// dele de fato indica que a mensagem nao saiu.
//
// Para destino de grupo, a ausencia de ACK nao e sinal de nada (ver o cabecalho
// do arquivo): devolve `confirmed: false` com SEM_ACK_DE_GRUPO e deixa o envio
// seguir como enviado.
//
// Quando nao da para consultar o ACK (banco da Evolution inalcancavel, driver
// ausente, confirmacao desligada), nao lanca: devolve `verified: false` e o
// envio segue como antes. Um problema de infraestrutura nossa nao pode reprovar
// mensagem que talvez tenha sido entregue - mas o log guarda NAO_VERIFICADO para
// o relatorio nao vender isso como entrega confirmada.
async function confirmProviderDelivery(result, options = {}) {
  const config = options.config || deliveryConfirmationConfig;
  const logger = options.logger || console;
  const context = options.context || {};
  const statusReader = options.messageStatusReader || defaultMessageStatusReader;
  const wait = options.wait || defaultWait;
  const now = options.now || (() => Date.now());

  const data = (result && result.data) || {};
  const key = data.key || {};
  const messageId = key.id || data.id || null;
  const providerMessageId = messageId ? String(messageId) : null;
  const acceptedStatus = data.status === undefined || data.status === null ? null : String(data.status);

  const unverified = (reason) => {
    logConfirmationEvent(logger, "warn", "delivery_confirmation.unverified", {
      ...context,
      provider_message_id: providerMessageId,
      accepted_status: acceptedStatus,
      reason,
    });

    return {
      confirmed: false,
      verified: false,
      provider_message_id: providerMessageId,
      provider_status: UNVERIFIED_PROVIDER_STATUS,
    };
  };

  if (!config.enabled) {
    return unverified("confirmacao_desligada");
  }

  if (!providerMessageId) {
    return unverified("resposta_sem_id_de_mensagem");
  }

  const toGroup = isGroupJid(key.remoteJid);
  // Janela curta para grupo: nao existe ACK para esperar, so vale dar tempo de a
  // Evolution persistir a linha (evidencia) e de um ACK de erro aparecer.
  const timeoutMs = toGroup
    ? Math.max(Number(config.groupTimeoutMs ?? config.timeoutMs) || 0, 0)
    : Math.max(Number(config.timeoutMs) || 0, 0);
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const pollIntervalMs = Math.max(Number(config.pollIntervalMs) || 0, 100);
  let lastStatus = acceptedStatus;
  let lookupAvailable = false;
  let messagePersisted = false;

  // Primeira leitura imediata: envio de texto costuma receber o ACK antes de a
  // resposta HTTP voltar, e nesse caso nao ha por que esperar um ciclo inteiro.
  for (;;) {
    const ack = await statusReader.findMessageAckStatus(providerMessageId, {
      config,
      instanceName: extractInstanceNameFromEndpoint(result && result.endpoint),
      remoteJid: key.remoteJid || null,
    });

    if (ack === null) {
      return unverified("consulta_de_ack_indisponivel");
    }

    lookupAvailable = true;

    if (ack.found) {
      messagePersisted = true;
    }

    if (ack.found && ack.status) {
      lastStatus = ack.status;
      const classification = classifyProviderAck(ack.status);

      if (classification === "confirmado") {
        logConfirmationEvent(logger, "info", "delivery_confirmation.confirmed", {
          ...context,
          provider_message_id: providerMessageId,
          provider_status: ack.status,
        });

        return {
          confirmed: true,
          verified: true,
          provider_message_id: providerMessageId,
          provider_status: ack.status,
        };
      }

      if (classification === "falhou") {
        throw buildNotConfirmedError(ack.status, now() - startedAt);
      }
    }

    if (now() >= deadline) {
      break;
    }

    await wait(Math.min(pollIntervalMs, deadline - now()));
  }

  if (!lookupAvailable) {
    return unverified("consulta_de_ack_indisponivel");
  }

  const waitedMs = now() - startedAt;

  // Grupo sem ACK: esperado, nao e falha. O log fica "enviado" com selo proprio.
  if (toGroup) {
    logConfirmationEvent(logger, "info", "delivery_confirmation.group_without_ack", {
      ...context,
      provider_message_id: providerMessageId,
      accepted_status: acceptedStatus,
      last_status: lastStatus,
      message_persisted: messagePersisted,
      waited_ms: waitedMs,
    });

    return {
      confirmed: false,
      verified: true,
      group_without_ack: true,
      message_persisted: messagePersisted,
      provider_message_id: providerMessageId,
      provider_status: GROUP_UNCONFIRMED_PROVIDER_STATUS,
    };
  }

  logConfirmationEvent(logger, "error", "delivery_confirmation.not_confirmed", {
    ...context,
    provider_message_id: providerMessageId,
    provider_status: lastStatus,
    waited_ms: waitedMs,
  });

  throw buildNotConfirmedError(lastStatus, waitedMs);
}

module.exports = {
  CONFIRMED_ACK_STATUSES,
  FAILED_ACK_STATUSES,
  GROUP_UNCONFIRMED_PROVIDER_STATUS,
  PENDING_ACK_STATUSES,
  UNVERIFIED_PROVIDER_STATUS,
  assertDeliveryConfirmed,
  classifyProviderAck,
  confirmProviderDelivery,
  extractInstanceNameFromEndpoint,
  extractProviderDelivery,
  isFailureLikeStatus,
  isGroupJid,
};
