require("dotenv").config({ quiet: true });

const IORedis = require("ioredis");

const redisConfig = {
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT || 6379),
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || "redis-local",
  db: Number(process.env.REDIS_DB || 0),
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

let sharedRedisConnection;

function createRedisConnection() {
  return new IORedis(redisConfig);
}

function getRedisConnection() {
  if (!sharedRedisConnection) {
    sharedRedisConnection = createRedisConnection();
  }

  return sharedRedisConnection;
}

async function closeRedisConnection() {
  if (!sharedRedisConnection) {
    return;
  }

  await sharedRedisConnection.quit();
  sharedRedisConnection = undefined;
}

module.exports = {
  closeRedisConnection,
  getRedisConnection,
  redisConfig,
};
