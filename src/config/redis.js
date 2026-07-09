require("dotenv").config();

const redisConfig = {
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT || 6379),
  username: process.env.REDIS_USERNAME || "default",
  password: process.env.REDIS_PASSWORD || "redis-local",
  db: Number(process.env.REDIS_DB || 0),
};

module.exports = {
  redisConfig,
};
