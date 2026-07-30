const fs = require("node:fs/promises");
const path = require("node:path");

const axios = require("axios");

const { evolutionConfig } = require("../config/evolution");

const MEDIA_TYPES = new Set(["image", "video", "audio", "document"]);

// Mapeamento simples para inferir o MIME type quando o envio informa arquivo/link.
const mimeTypesByExtension = {
  ".aac": "audio/aac",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

class EvolutionApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "EvolutionApiError";
    this.status = details.status;
    this.response = details.response;
    this.cause = details.cause;
    this.code = details.code;
    // Sinaliza para o sweep de dispatch-failure-retry que repetir a requisicao
    // identica nao muda o resultado (ver PERMANENT_ERROR_STATUSES).
    this.permanent = Boolean(details.permanent);
  }
}

function normalizeBaseUrl(baseUrl) {
  // Evita duplicar barras ao concatenar baseURL e endpoint.
  return baseUrl.replace(/\/+$/, "");
}

function createEvolutionClient(config = evolutionConfig, options = {}) {
  // Client HTTP isolado para manter autenticacao e timeout fora do fluxo de negocio.
  const timeout = options.timeoutMs || config.timeoutMs;

  return axios.create({
    baseURL: normalizeBaseUrl(config.baseUrl),
    timeout,
    headers: {
      apikey: config.apiKey,
      "Content-Type": "application/json",
    },
  });
}

function assertRequired(value, fieldName) {
  // Padroniza validacoes de entrada para o wrapper falhar antes da chamada externa.
  if (value === undefined || value === null || value === "") {
    throw new EvolutionApiError(`Campo obrigatorio ausente: ${fieldName}`);
  }
}

function inferMediaType(mimeType) {
  // A Evolution espera `mediatype`; quando nao for midia comum, enviamos documento.
  if (!mimeType) {
    return "document";
  }

  const [category] = mimeType.split("/");

  return MEDIA_TYPES.has(category) ? category : "document";
}

function inferMimeType(fileNameOrPath) {
  // Usa a extensao do arquivo como fallback quando o chamador nao envia `mimeType`.
  const extension = path.extname(fileNameOrPath || "").toLowerCase();

  return mimeTypesByExtension[extension] || "application/octet-stream";
}

async function buildMediaFromFile(filePath) {
  // Arquivos locais sao convertidos para base64 antes de compor o payload.
  const fileBuffer = await fs.readFile(filePath);

  return fileBuffer.toString("base64");
}

async function buildMediaPayload(params) {
  // Monta o payload aceito pelo endpoint /message/sendMedia/:instance.
  const content = params.content || {};
  const fileName = content.fileName || (content.filePath ? path.basename(content.filePath) : undefined);
  const mimeType = content.mimeType || inferMimeType(fileName || content.url);
  const mediaType = content.type || inferMediaType(mimeType);
  let media = content.base64 || content.url || content.link || params.contentUrl;

  if (content.filePath) {
    media = await buildMediaFromFile(content.filePath);
  }

  assertRequired(media, "content.url, content.base64 ou content.filePath");

  return {
    number: params.groupId,
    mediatype: mediaType,
    mimetype: mimeType,
    caption: params.message || params.caption || "",
    media,
    fileName,
  };
}

// Mede o corpo que sera realmente enviado (base64 + campos do JSON) e barra o
// envio quando ele passa do limite do body-parser da Evolution. Sem isso o
// backend fazia o upload inteiro de um payload condenado a HTTP 413 — e, no caso
// de video, depois de ja ter baixado ~125 MB do Google Drive.
function assertMediaPayloadWithinLimit(payload, config = evolutionConfig) {
  const limitBytes = Number(config.maxMediaPayloadBytes);

  if (!Number.isFinite(limitBytes) || limitBytes <= 0 || !payload || !payload.media) {
    return;
  }

  const payloadBytes = Buffer.byteLength(JSON.stringify(payload));

  if (payloadBytes <= limitBytes) {
    return;
  }

  throw new EvolutionApiError(
    `Payload de midia com ${payloadBytes} bytes excede o limite de ${limitBytes} bytes aceito pela Evolution API; ` +
      "reduza o video antes do envio",
    {
      code: "EVOLUTION_PAYLOAD_TOO_LARGE",
      permanent: true,
    }
  );
}

function buildTextPayload(params) {
  // Monta o payload aceito pelo endpoint /message/sendText/:instance.
  const text = params.message || params.caption;

  assertRequired(text, "message");

  return {
    number: params.groupId,
    text,
  };
}

function buildEvolutionRequest(params, config = evolutionConfig) {
  // Decide o endpoint com base na presenca de conteudo/midia.
  assertRequired(params, "params");
  assertRequired(params.groupId, "groupId");

  const hasContent = Boolean(params.content || params.contentUrl);
  const pathPrefix = hasContent ? "message/sendMedia" : "message/sendText";
  const endpoint = `/${pathPrefix}/${config.instanceName}`;

  return {
    endpoint,
    hasContent,
  };
}

function buildFetchAllGroupsRequest(config = evolutionConfig, options = {}) {
  const getParticipants =
    options.getParticipants !== undefined
      ? options.getParticipants
      : options.get_participants !== undefined
        ? options.get_participants
        : true;

  return {
    endpoint: `/group/fetchAllGroups/${config.instanceName}`,
    params: {
      getParticipants,
    },
  };
}

const TIMEOUT_ERROR_CODES = new Set(["ECONNABORTED", "ETIMEDOUT"]);

function isAxiosTimeout(error) {
  // O axios usa ECONNABORTED para timeout de `timeout:` config; ETIMEDOUT vem do socket/DNS.
  // A mensagem tambem carrega "timeout" em alguns casos sem um `code` definido.
  return TIMEOUT_ERROR_CODES.has(error.code) || /timeout/i.test(error.message || "");
}

// A Evolution API responde erro no formato
// `{ status, error: "Internal Server Error", response: { message } }` — o campo
// `error` e quase sempre o texto generico do handler global dela, e a causa real
// fica em `response.message`. Por isso `response.message` e testado ANTES de
// `error`: com a ordem invertida, um HTTP 413 do body-parser (payload acima do
// limite de 136 MB) era registrado como "Internal Server Error", escondendo o
// "request entity too large" que explica a falha.
// `response.message` nem sempre e texto: na validacao de destinatario a Evolution
// devolve uma lista de objetos (`[{ jid, exists, number }]`). Serializar e melhor
// que descartar — sem isso o detalhe caia em "[object Object]" ou no generico.
function normalizeEvolutionErrorCandidate(candidate) {
  if (typeof candidate === "string") {
    return candidate.trim() || null;
  }

  if (Array.isArray(candidate)) {
    const parts = candidate.map(normalizeEvolutionErrorCandidate).filter(Boolean);

    return parts.length ? parts.join("; ") : null;
  }

  if (candidate && typeof candidate === "object") {
    return JSON.stringify(candidate);
  }

  return null;
}

function summarizeEvolutionResponseError(response) {
  const data = response && response.data;
  const candidates = [
    typeof data === "string" ? data : null,
    data && data.message,
    data && data.error && data.error.message,
    data && data.response && data.response.message,
    data && data.error,
  ];
  const message = candidates.map(normalizeEvolutionErrorCandidate).find(Boolean);

  // A mensagem vai para log/notificacao. Limita seu tamanho para evitar que uma
  // resposta HTML ou um payload inesperado da API torne o registro inutilizavel.
  return message ? message.trim().replace(/\s+/g, " ").slice(0, 500) : null;
}

// Status que nao mudam de resultado ao repetir a mesma requisicao: payload acima
// do limite, requisicao malformada, credencial invalida, grupo/instancia
// inexistente. Reenfileirar esses casos so repete o download do video do Drive e
// a notificacao de falha no WhatsApp, sem chance de sucesso.
const PERMANENT_ERROR_STATUSES = new Set([400, 401, 403, 404, 413, 415, 422]);

function isPermanentEvolutionStatus(status) {
  return PERMANENT_ERROR_STATUSES.has(Number(status));
}

// O body-parser da Evolution API responde 413 sem mensagem util quando o corpo
// passa do limite dela (136 MB, fixo no bundle). Explicitamos a causa para que o
// log e a notificacao digam o que fazer em vez de "Internal Server Error".
function describePayloadTooLarge(config = evolutionConfig) {
  const limitMb = Math.round(config.maxMediaPayloadBytes / 1024 / 1024);

  return (
    `Payload recusado pela Evolution API por exceder o limite de corpo da requisicao (~${limitMb} MB). ` +
    "A midia vai em base64 (+33% sobre o arquivo), entao o video precisa ser reduzido antes do envio"
  );
}

function parseEvolutionError(error, config = evolutionConfig) {
  // Converte erros do axios em um erro unico do modulo, com dados uteis para log/retry.
  if (error.response) {
    const status = error.response.status;
    const responseMessage =
      Number(status) === 413 ? describePayloadTooLarge(config) : summarizeEvolutionResponseError(error.response);
    const detail = [status ? `HTTP ${status}` : null, responseMessage].filter(Boolean).join(": ");

    return new EvolutionApiError(`Falha na chamada para Evolution API${detail ? ` (${detail})` : ""}`, {
      status: error.response.status,
      response: error.response.data,
      cause: error,
      code: Number(status) === 413 ? "EVOLUTION_PAYLOAD_TOO_LARGE" : undefined,
      permanent: isPermanentEvolutionStatus(status),
    });
  }

  if (error.request) {
    // Timeout (`ECONNABORTED`/`ETIMEDOUT`) nao significa que a Evolution API esta fora do
    // ar: a requisicao pode ter sido processada e a midia entregue mesmo assim, so nao
    // respondeu dentro do prazo. Diferenciamos aqui para log/notificacao nao afirmarem
    // "indisponivel" quando na verdade foi so demora (comum em envio de video grande).
    if (isAxiosTimeout(error)) {
      return new EvolutionApiError(
        "Tempo limite excedido aguardando resposta da Evolution API (a midia pode ter sido entregue mesmo assim)",
        {
          code: "EVOLUTION_TIMEOUT",
          cause: error,
        },
      );
    }

    return new EvolutionApiError("Evolution API indisponivel ou sem resposta", {
      code: "EVOLUTION_NO_RESPONSE",
      cause: error,
    });
  }

  return new EvolutionApiError(error.message, {
    cause: error,
  });
}

class EvolutionDeliveryProvider {
  constructor(options = {}) {
    // Permite injetar client/config em testes ou trocar detalhes de transporte no futuro.
    this.config = options.config || evolutionConfig;
    this.client = options.client || createEvolutionClient(this.config);
  }

  async send(params) {
    // Contrato unico de envio: o restante da aplicacao nao conhece endpoints da Evolution.
    const request = buildEvolutionRequest(params, this.config);
    const payload = request.hasContent ? await buildMediaPayload(params) : buildTextPayload(params);
    // Midia usa um timeout maior (config.mediaTimeoutMs) pois o payload em base64 e o
    // processamento na Evolution API demoram bem mais do que uma mensagem de texto.
    const requestTimeout = request.hasContent ? this.config.mediaTimeoutMs : this.config.timeoutMs;

    assertMediaPayloadWithinLimit(payload, this.config);

    try {
      const response = await this.client.post(request.endpoint, payload, {
        timeout: requestTimeout,
      });

      return {
        provider: "evolution",
        endpoint: request.endpoint,
        status: response.status,
        data: response.data,
      };
    } catch (error) {
      throw parseEvolutionError(error, this.config);
    }
  }

  async fetchAllGroups(options = {}) {
    const request = buildFetchAllGroupsRequest(this.config, options);

    try {
      const response = await this.client.get(request.endpoint, { params: request.params });

      return {
        provider: "evolution",
        endpoint: request.endpoint,
        status: response.status,
        data: response.data,
      };
    } catch (error) {
      throw parseEvolutionError(error, this.config);
    }
  }
}

async function sendToEvolution(params, options = {}) {
  // Funcao publica usada pelo fluxo de distribuicao.
  const provider = new EvolutionDeliveryProvider(options);

  return provider.send(params);
}

async function fetchAllGroupsFromEvolution(options = {}) {
  const timeoutMs = Number(options.timeoutMs || options.timeout_ms || 0);
  const providerOptions = timeoutMs
    ? {
        ...options,
        config: {
          ...evolutionConfig,
          ...(options.config || {}),
          timeoutMs,
        },
      }
    : options;
  const provider = new EvolutionDeliveryProvider(providerOptions);

  return provider.fetchAllGroups(options);
}

module.exports = {
  EvolutionApiError,
  EvolutionDeliveryProvider,
  PERMANENT_ERROR_STATUSES,
  assertMediaPayloadWithinLimit,
  buildFetchAllGroupsRequest,
  buildEvolutionRequest,
  createEvolutionClient,
  fetchAllGroupsFromEvolution,
  isPermanentEvolutionStatus,
  parseEvolutionError,
  summarizeEvolutionResponseError,
  sendToEvolution,
};
