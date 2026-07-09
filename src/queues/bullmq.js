const { Queue, QueueEvents, Worker } = require("bullmq");

const { closeRedisConnection, getRedisConnection } = require("../config/redis");

const defaultJobOptions = {
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 5000,
  },
  removeOnComplete: {
    age: 60 * 60 * 24,
    count: 1000,
  },
  removeOnFail: {
    age: 60 * 60 * 24 * 7,
    count: 5000,
  },
};

function buildQueueOptions(options = {}) {
  const { defaultJobOptions: jobOptions = {}, ...queueOptions } = options;

  return {
    ...queueOptions,
    connection: getRedisConnection(),
    defaultJobOptions: {
      ...defaultJobOptions,
      ...jobOptions,
    },
  };
}

function createQueue(name, options = {}) {
  return new Queue(name, buildQueueOptions(options));
}

function createWorker(name, processor, options = {}) {
  return new Worker(name, processor, {
    ...options,
    connection: getRedisConnection(),
  });
}

function createQueueEvents(name, options = {}) {
  return new QueueEvents(name, {
    ...options,
    connection: getRedisConnection(),
  });
}

async function closeQueueInfrastructure() {
  await closeRedisConnection();
}

module.exports = {
  closeQueueInfrastructure,
  createQueue,
  createQueueEvents,
  createWorker,
  defaultJobOptions,
};
