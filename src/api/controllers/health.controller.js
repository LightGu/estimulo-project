const { getRedisConnection } = require("../../config/redis");

function createHealthController(dependencies = {}) {
  const redisTimeoutMs = Number(dependencies.redisTimeoutMs || process.env.HEALTH_REDIS_TIMEOUT_MS || 1000);

  function getRedisClient() {
    return dependencies.redisClient || getRedisConnection();
  }

  function withTimeout(promise, timeoutMs) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Redis health check timeout")), timeoutMs)
      ),
    ]);
  }

  return async function health(req, res) {
    const timestamp = new Date().toISOString();
    const redis = {
      status: "ok",
      latency: null,
    };

    try {
      const startedAt = Date.now();
      await withTimeout(getRedisClient().ping(), redisTimeoutMs);
      redis.latency = Date.now() - startedAt;
    } catch (error) {
      redis.status = "error";
      redis.error = error.message;
    }

    const isHealthy = redis.status === "ok";

    return res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? "ok" : "error",
      timestamp,
      checks: {
        application: {
          status: "ok",
        },
        redis,
      },
    });
  };
}

module.exports = createHealthController;
