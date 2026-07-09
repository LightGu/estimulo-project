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
  }
}

function normalizeBaseUrl(baseUrl) {
  // Evita duplicar barras ao concatenar baseURL e endpoint.
  return baseUrl.replace(/\/+$/, "");
}

function createEvolutionClient(config = evolutionConfig) {
  // Client HTTP isolado para manter autenticacao e timeout fora do fluxo de negocio.
  return axios.create({
    baseURL: normalizeBaseUrl(config.baseUrl),
    timeout: config.timeoutMs,
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

function parseEvolutionError(error) {
  // Converte erros do axios em um erro unico do modulo, com dados uteis para log/retry.
  if (error.response) {
    return new EvolutionApiError("Falha na chamada para Evolution API", {
      status: error.response.status,
      response: error.response.data,
      cause: error,
    });
  }

  if (error.request) {
    return new EvolutionApiError("Evolution API indisponivel ou sem resposta", {
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

    try {
      const response = await this.client.post(request.endpoint, payload);

      return {
        provider: "evolution",
        endpoint: request.endpoint,
        status: response.status,
        data: response.data,
      };
    } catch (error) {
      throw parseEvolutionError(error);
    }
  }
}

async function sendToEvolution(params, options = {}) {
  // Funcao publica usada pelo fluxo de distribuicao.
  const provider = new EvolutionDeliveryProvider(options);

  return provider.send(params);
}

module.exports = {
  EvolutionApiError,
  EvolutionDeliveryProvider,
  buildEvolutionRequest,
  sendToEvolution,
};
