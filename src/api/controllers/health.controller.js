const { getRedisConnection } = require("../../config/redis");

function createHealthController(dependencies = {}) {
  const redisClient = dependencies.redisClient || getRedisConnection();

  return async function health(req, res) {
    const timestamp = new Date().toISOString();
    const redis = {
      status: "ok",
      latency: null,
    };

    try {
      const startedAt = Date.now();
      await redisClient.ping();
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
