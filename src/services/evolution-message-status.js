const { deliveryConfirmationConfig } = require("../config/evolution");

// Le o ACK de uma mensagem direto do banco da Evolution.
//
// Por que aqui e nao pela API: na v2.3.7 a rota `POST /chat/findMessages` nao
// devolve `Message.status` (o `select` do Prisma nao inclui a coluna) e a
// relacao `MessageUpdate` volta vazia mesmo para mensagens de grupo que ja
// chegaram a READ. Sem essa leitura direta, a aplicacao nao tem como distinguir
// "a Evolution aceitou" de "o WhatsApp entregou" — que e exatamente a diferenca
// entre o relatorio dizer a verdade e mentir.
//
// Nunca inventa resposta: quando o banco nao esta configurado, o driver nao esta
// instalado ou a consulta falha, devolve `null` (= "nao sei"). Quem chama trata
// "nao sei" de forma diferente de "nao entregue" — um erro de infraestrutura
// nossa nao pode reprovar um envio que talvez tenha dado certo.

const MESSAGE_STATUS_QUERY = `
  SELECT m.status
  FROM "Message" m
  WHERE m."key"->>'id' = $1
  ORDER BY m."messageTimestamp" DESC
  LIMIT 1
`;

let cachedPool;
let cachedPoolFailed = false;

function isDatabaseConfigured(config = deliveryConfirmationConfig) {
  if (config.databaseUrl) {
    return true;
  }

  return Boolean(config.databaseHost && config.databaseUser && config.databaseName);
}

function buildPoolOptions(config = deliveryConfirmationConfig) {
  if (config.databaseUrl) {
    return { connectionString: config.databaseUrl, max: 2, idleTimeoutMillis: 30000 };
  }

  return {
    host: config.databaseHost,
    port: config.databasePort,
    user: config.databaseUser,
    password: config.databasePassword,
    database: config.databaseName,
    max: 2,
    idleTimeoutMillis: 30000,
  };
}

// Pool unico por processo e criado sob demanda: um worker que nunca envia nada
// nao abre conexao com a Evolution, e uma falha na criacao (driver ausente) e
// lembrada para nao repetir o require a cada mensagem.
function getPool(config = deliveryConfirmationConfig) {
  if (cachedPool || cachedPoolFailed) {
    return cachedPool || null;
  }

  if (!isDatabaseConfigured(config)) {
    cachedPoolFailed = true;
    return null;
  }

  try {
    const { Pool } = require("pg");
    cachedPool = new Pool(buildPoolOptions(config));
    // Sem este handler, uma queda de conexao ociosa derruba o processo inteiro
    // com um erro nao tratado — o worker de envio nao pode morrer por causa da
    // leitura de evidencia.
    cachedPool.on("error", () => {});
  } catch (error) {
    cachedPoolFailed = true;
    cachedPool = null;
  }

  return cachedPool;
}

async function findMessageAckStatus(messageId, options = {}) {
  if (!messageId) {
    return null;
  }

  const pool = options.pool || getPool(options.config || deliveryConfirmationConfig);

  if (!pool) {
    return null;
  }

  try {
    const result = await pool.query(MESSAGE_STATUS_QUERY, [String(messageId)]);
    const row = (result && result.rows && result.rows[0]) || null;

    if (!row) {
      // A mensagem ainda nao foi persistida pela Evolution. Nao e "nao
      // entregue": e cedo demais para saber.
      return { found: false, status: null };
    }

    return { found: true, status: row.status || null };
  } catch (error) {
    // Este catch devolvia `null` sem uma linha de log, e foi o que manteve um
    // problema de configuracao invisivel por semanas: com EVOLUTION_DB_HOST
    // ausente, todo envio caia aqui com ECONNREFUSED e era registrado como
    // "NAO_VERIFICADO", indistinguivel de uma instancia sem banco configurado
    // de proposito. `null` continua sendo a resposta certa para quem chama
    // ("nao sei" nunca pode reprovar um envio que talvez tenha dado certo) -
    // o que faltava era dizer POR QUE nao se sabe.
    //
    // Uma vez por processo por codigo de erro: a alternativa e' uma linha por
    // mensagem enviada, que afogaria o log do worker sem informacao nova.
    reportLookupFailure(error);

    return null;
  }
}

const reportedLookupFailures = new Set();

function reportLookupFailure(error, logger = console) {
  const code = (error && (error.code || error.name)) || "UNKNOWN";

  if (reportedLookupFailures.has(code)) {
    return;
  }

  reportedLookupFailures.add(code);

  logger.error &&
    logger.error(
      JSON.stringify({
        event: "delivery_confirmation.lookup_unavailable",
        error_code: code,
        error_message: (error && error.message) || String(error),
        host: deliveryConfirmationConfig.databaseUrl ? "(via EVOLUTION_DB_URL)" : deliveryConfirmationConfig.databaseHost,
        port: deliveryConfirmationConfig.databaseUrl ? null : deliveryConfirmationConfig.databasePort,
        note:
          "sem esta consulta nenhum ACK e lido e todo envio fica com provider_status NAO_VERIFICADO; " +
          "conferir EVOLUTION_DB_HOST/EVOLUTION_DB_PORT no ambiente do container",
        // Registrado uma vez por codigo de erro, por processo.
        once_per_process: true,
      })
    );
}

module.exports = {
  MESSAGE_STATUS_QUERY,
  findMessageAckStatus,
  isDatabaseConfigured,
  reportLookupFailure,
};
