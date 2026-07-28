// Lancado para respostas que indicam que o MODELO (nao a requisicao) e o problema:
// cota zerada/esgotada ou modelo descontinuado/indisponivel para a chave atual.
// Nesses casos faz sentido tentar o proximo modelo da cascata de fallback.
class SkippableModelError extends Error {
  constructor(message) {
    super(message);
    this.name = "SkippableModelError";
  }
}

const RateLimitError = SkippableModelError;

function assertFetch(fetchImplementation, providerName) {
  if (typeof fetchImplementation !== "function") {
    throw new Error(`fetch e obrigatorio para gerar legenda com ${providerName}`);
  }
}

function isRateLimitStatus(status) {
  return status === 429 || status === 404;
}

function isRateLimitMessage(message) {
  const normalized = String(message || "").toLowerCase();

  return (
    normalized.includes("quota") ||
    normalized.includes("rate limit") ||
    normalized.includes("resource_exhausted") ||
    normalized.includes("resource exhausted") ||
    normalized.includes("no longer available") ||
    normalized.includes("not found") ||
    normalized.includes("not supported")
  );
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
      throw new SkippableModelError(errorMessage);
    }

    throw new Error(errorMessage);
  }

  return parsed;
}

module.exports = {
  RateLimitError,
  SkippableModelError,
  assertFetch,
  isRateLimitMessage,
  isRateLimitStatus,
  readResponseJson,
};
