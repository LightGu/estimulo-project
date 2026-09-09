const { getRedisConnection } = require("../../config/redis");

/*
  Health check da API.

  Antes olhava SO o Redis, e o healthcheck do Docker consome esta resposta -
  entao o container era considerado saudavel com o Supabase inalcancavel. Isso
  importava mais do que parece: as correcoes que trocaram `.catch(() => null)`
  por `throw` nos portoes de pausa/cancelamento (queues/dispatch.js e
  queues/mensagens-dispatch.js) transformam indisponibilidade do banco em falhas
  de envio em massa, cada uma com sua notificacao. Sem um sinal de saude que
  enxergue o banco, nao ha como distinguir "a plataforma esta degradada" de
  "estes envios falharam".

  Tambem passa a reportar o banco de ACK da Evolution, que ficou inerte em
  producao por semanas sem nenhum sintoma visivel (EVOLUTION_DB_HOST caia no
  default "localhost", que dentro do container e' o proprio container).

  Distingue tres estados, e a diferenca e' deliberada:

    ok        - tudo respondendo.
    degraded  - HTTP 200. Uma dependencia NAO essencial esta fora (o banco de
                ACK). O compose nao deve reiniciar a API por isso: reiniciar nao
                conserta um servico externo e so interrompe envios em andamento.
    error     - HTTP 503. Redis ou Supabase fora: a API nao consegue enfileirar
                nem registrar nada, e reiniciar/parar de receber trafego e' a
                resposta certa.
*/
function createHealthController(dependencies = {}) {
  const redisTimeoutMs = Number(dependencies.redisTimeoutMs || process.env.HEALTH_REDIS_TIMEOUT_MS || 1000);
  const databaseTimeoutMs = Number(
    dependencies.databaseTimeoutMs || process.env.HEALTH_DATABASE_TIMEOUT_MS || 2000
  );

  function getRedisClient() {
    return dependencies.redisClient || getRedisConnection();
  }

  function getDatabaseClient() {
    return dependencies.databaseClient || require("../../database/client");
  }

  function getMessageStatusReader() {
    return dependencies.messageStatusReader || require("../../services/evolution-message-status");
  }

  function withTimeout(promise, timeoutMs, message) {
    let timer;

    return Promise.race([
      Promise.resolve(promise).finally(() => clearTimeout(timer)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  }

  async function measure(check) {
    const startedAt = Date.now();

    try {
      await check();
      return { status: "ok", latency: Date.now() - startedAt };
    } catch (error) {
      return { status: "error", latency: Date.now() - startedAt, error: error.message };
    }
  }

  async function checkRedis() {
    return measure(() => withTimeout(getRedisClient().ping(), redisTimeoutMs, "Redis health check timeout"));
  }

  // Consulta mais barata possivel que ainda prova o caminho inteiro (rede, auth,
  // schema): conta linhas de `settings` com head:true, que nao transfere dados.
  async function checkDatabase() {
    return measure(() =>
      withTimeout(
        (async () => {
          const { error } = await getDatabaseClient()
            .from("settings")
            .select("key", { count: "exact", head: true });

          if (error) {
            throw error;
          }
        })(),
        databaseTimeoutMs,
        "Supabase health check timeout"
      )
    );
  }

  // O banco de ACK e' opcional por design (DELIVERY_CONFIRMATION_ENABLED=false
  // e' uma valvula de escape legitima), entao "desligado" nao e' problema -
  // "ligado e inalcancavel" e.
  async function checkDeliveryConfirmation() {
    const reader = getMessageStatusReader();
    const { deliveryConfirmationConfig } = require("../../config/evolution");

    if (!deliveryConfirmationConfig.enabled) {
      return { status: "disabled" };
    }

    if (typeof reader.isDatabaseConfigured === "function" && !reader.isDatabaseConfigured()) {
      return { status: "not_configured" };
    }

    const result = await measure(async () => {
      const ack = await withTimeout(
        reader.findMessageAckStatus("health-probe"),
        databaseTimeoutMs,
        "Evolution ACK database health check timeout"
      );

      // findMessageAckStatus nunca lanca: devolve null quando nao conseguiu
      // consultar. "health-probe" nao existe, entao a resposta saudavel e
      // { found: false } - `null` significa que a consulta em si falhou.
      if (ack === null) {
        throw new Error(
          "consulta de ACK indisponivel (conferir EVOLUTION_DB_HOST/EVOLUTION_DB_PORT no container)"
        );
      }
    });

    return result;
  }

  return async function health(req, res) {
    const timestamp = new Date().toISOString();
    const [redis, database, deliveryConfirmation] = await Promise.all([
      checkRedis(),
      checkDatabase(),
      checkDeliveryConfirmation(),
    ]);

    // Essenciais: sem Redis nao ha fila, sem Supabase nao ha registro.
    const essentialsDown = redis.status === "error" || database.status === "error";
    const status = essentialsDown ? "error" : deliveryConfirmation.status === "error" ? "degraded" : "ok";

    res.set("Cache-Control", "no-store");

    return res.status(essentialsDown ? 503 : 200).json({
      status,
      timestamp,
      checks: {
        application: { status: "ok" },
        redis,
        database,
        delivery_confirmation: deliveryConfirmation,
      },
    });
  };
}

module.exports = createHealthController;
