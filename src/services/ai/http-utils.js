// Lancado para respostas que indicam que o MODELO (nao a requisicao) e o problema:
// cota zerada/esgotada ou modelo descontinuado/indisponivel para a chave atual.
// Nesses casos faz sentido tentar o proximo modelo da cascata de fallback.
//
// `retired: true` distingue o que NUNCA vai voltar a funcionar (modelo removido /
// indisponivel para a chave) do que e temporario (cota diaria, sobrecarga). Isso
// permite ao adapter memorizar os modelos mortos e nao gastar uma requisicao neles
// em cada envio.
class SkippableModelError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "SkippableModelError";
    this.retired = Boolean(options.retired);
  }
}

const RateLimitError = SkippableModelError;

function assertFetch(fetchImplementation, providerName) {
  if (typeof fetchImplementation !== "function") {
    throw new Error(`fetch e obrigatorio para gerar legenda com ${providerName}`);
  }
}

// Falhas de rede (DNS, conexao derrubada, socket fechado pelo outro lado) fazem o
// fetch do Node REJEITAR — nao chegam em readResponseJson, que so trata resposta
// HTTP. O erro resultante e um `TypeError: fetch failed` sem contexto, e como ele
// nao e SkippableModelError a cascata de modelos do adapter reergue na hora, sem
// tentar de novo. Era isso que derrubava uma legenda isolada no meio de um lote
// com "fetch failed" no log.
const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const DEFAULT_FETCH_RETRY_ATTEMPTS = 3;
const DEFAULT_FETCH_RETRY_BASE_DELAY_MS = 700;

// O motivo real de um "fetch failed" fica em error.cause (as vezes aninhado mais
// de um nivel), nao na mensagem de cima.
function collectErrorChain(error) {
  const chain = [];
  let current = error;

  while (current && chain.length < 5) {
    chain.push(current);
    current = current.cause;
  }

  return chain;
}

function isTransientNetworkError(error) {
  if (!error) {
    return false;
  }

  return collectErrorChain(error).some(
    (item) =>
      TRANSIENT_NETWORK_ERROR_CODES.has(item.code) ||
      /fetch failed|socket hang up|other side closed|network|terminated/i.test(item.message || "")
  );
}

// Transforma "fetch failed" em algo diagnosticavel: o que estava sendo chamado e
// qual o codigo/motivo de rede por baixo.
function describeFetchFailure(error, context) {
  const chain = collectErrorChain(error);
  const detail = chain
    .slice(1)
    .map((item) => [item.code, item.message].filter(Boolean).join(": "))
    .find(Boolean);
  const base = (error && error.message) || "falha de rede";

  return [context, detail ? `${base} (${detail})` : base].filter(Boolean).join(": ");
}

// Repete a chamada em falha de rede com backoff exponencial. Erros HTTP nao
// passam por aqui: quem responde com status fica a cargo de readResponseJson, que
// decide entre pular o modelo (cota/indisponivel) e falhar de vez.
async function fetchWithRetry(fetchImplementation, url, init, options = {}) {
  const attempts = Number(options.retryAttempts) > 0 ? Number(options.retryAttempts) : DEFAULT_FETCH_RETRY_ATTEMPTS;
  const baseDelayMs =
    Number(options.retryBaseDelayMs) > 0 ? Number(options.retryBaseDelayMs) : DEFAULT_FETCH_RETRY_BASE_DELAY_MS;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchImplementation(url, init);
    } catch (error) {
      if (!isTransientNetworkError(error)) {
        throw error;
      }

      lastError = error;

      if (attempt === attempts) {
        break;
      }

      if (typeof options.onRetry === "function") {
        options.onRetry({ attempt, attempts, error, context: options.context });
      }

      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }

  const failure = new Error(
    describeFetchFailure(lastError, `${options.context || "Chamada HTTP"} falhou apos ${attempts} tentativa(s)`)
  );

  failure.cause = lastError;
  failure.code = "AI_NETWORK_ERROR";

  throw failure;
}

function isRateLimitStatus(status) {
  // 429/404: cota/modelo indisponivel. 500/503: modelo sobrecarregado ou
  // indisponivel temporariamente ("high demand"/"overloaded") — nesses casos
  // tambem faz sentido tentar o proximo modelo da cascata de fallback.
  return status === 429 || status === 404 || status === 500 || status === 503;
}

function isRateLimitMessage(message) {
  const normalized = String(message || "").toLowerCase();

  return (
    normalized.includes("quota") ||
    normalized.includes("rate limit") ||
    normalized.includes("resource_exhausted") ||
    normalized.includes("resource exhausted") ||
    normalized.includes("high demand") ||
    normalized.includes("overloaded") ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("try again later") ||
    isRetiredModelMessage(normalized)
  );
}

// Mensagens de modelo definitivamente indisponivel para esta chave. Ex.: "This
// model models/gemini-2.5-flash-lite is no longer available to new users. Please
// update your code to use a newer model." Nao adianta repetir a chamada.
function isRetiredModelMessage(message) {
  const normalized = String(message || "").toLowerCase();

  return (
    normalized.includes("no longer available") ||
    normalized.includes("is not found") ||
    normalized.includes("not found") ||
    normalized.includes("not supported") ||
    normalized.includes("deprecated") ||
    normalized.includes("has been retired") ||
    normalized.includes("use a newer model")
  );
}

function isRetiredModelResponse(status, message) {
  return status === 404 || isRetiredModelMessage(message);
}

async function readResponseJson(response, context) {
  const text = await response.text();
  let parsed = {};

  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      parsed = {};
    }
  }

  if (!response.ok) {
    const apiMessage = parsed?.error?.message || text;
    const errorMessage = `${context}: ${apiMessage || response.statusText}`;

    if (isRateLimitStatus(response.status) || isRateLimitMessage(apiMessage)) {
      throw new SkippableModelError(errorMessage, {
        retired: isRetiredModelResponse(response.status, apiMessage),
      });
    }

    throw new Error(errorMessage);
  }

  return parsed;
}

module.exports = {
  DEFAULT_FETCH_RETRY_ATTEMPTS,
  DEFAULT_FETCH_RETRY_BASE_DELAY_MS,
  RateLimitError,
  SkippableModelError,
  TRANSIENT_NETWORK_ERROR_CODES,
  assertFetch,
  describeFetchFailure,
  fetchWithRetry,
  isRateLimitMessage,
  isRateLimitStatus,
  isRetiredModelMessage,
  isRetiredModelResponse,
  isTransientNetworkError,
  readResponseJson,
};
