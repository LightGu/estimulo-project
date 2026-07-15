const { getRedisConnection } = require("../../config/redis");
const { queueNames } = require("../../queues/names");
const dispatchQueueModule = require("../../queues/dispatch");
const dispatchLogsService = require("../../services/dispatch-logs.service");

function createHealthController(dependencies = {}) {
  const redisClient = dependencies.redisClient || getRedisConnection();
  const queueName = dependencies.queueName || queueNames.dispatch;
  const dispatchLogsServiceDependency = dependencies.dispatchLogsService || dispatchLogsService;
  const dispatchQueueFactory = dependencies.dispatchQueueFactory || (() => dispatchQueueModule.dispatchQueue);

  return async function health(req, res) {
    const timestamp = new Date().toISOString();
    const checks = {};

    let redisStatus = "ok";
    let redisLatency = null;
    let redisError = null;

    try {
      const startedAt = Date.now();
      await redisClient.ping();
      redisLatency = Date.now() - startedAt;
    } catch (error) {
      redisStatus = "error";
      redisError = error.message;
    }

    checks.redis = {
      status: redisStatus,
      latency: redisLatency,
      error: redisError,
    };

    checks.database = { status: "ok" };

    try {
      const queue = dispatchQueueFactory();
      const counts = await queue.getJobCounts();
      const queueStatus = redisStatus === "ok" ? "ok" : "warning";

      checks.queue = {
        status: queueStatus,
        waiting: counts.waiting || 0,
        active: counts.active || 0,
        completed: counts.completed || 0,
        failed: counts.failed || 0,
        delayed: counts.delayed || 0,
      };

      const lastDispatch = await dispatchLogsServiceDependency.listRecent(1);
      const latestEntry = Array.isArray(lastDispatch) && lastDispatch.length > 0 ? lastDispatch[0] : null;
      const ageMinutes = latestEntry && latestEntry.criado_em
        ? Math.round((Date.now() - new Date(latestEntry.criado_em).getTime()) / 60000)
        : null;

      checks.dispatch = {
        status: ageMinutes === null ? "warning" : ageMinutes <= 10 ? "ok" : "warning",
        lastExecution: latestEntry?.criado_em || null,
        minutesSinceLastDispatch: ageMinutes,
      };
    } catch (error) {
      checks.queue = {
        status: "warning",
        error: error.message,
      };
      checks.dispatch = {
        status: "warning",
        error: error.message,
      };
    }

    const status = Object.values(checks).some((check) => check?.status === "error") ? "error" : "ok";

    return res.json({
      status,
      timestamp,
      checks: {
        database: checks.database,
        redis: checks.redis,
        queue: checks.queue,
        dispatch: checks.dispatch,
      },
      queue: {
        waiting: checks.queue?.waiting || 0,
        active: checks.queue?.active || 0,
        failed: checks.queue?.failed || 0,
        completed: checks.queue?.completed || 0,
        delayed: checks.queue?.delayed || 0,
      },
      dispatch: {
        lastExecution: checks.dispatch?.lastExecution || null,
        minutesSinceLastDispatch: checks.dispatch?.minutesSinceLastDispatch || null,
      },
    });
  };
}

module.exports = createHealthController;
