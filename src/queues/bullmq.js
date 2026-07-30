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

// Queue/Worker/QueueEvents sao EventEmitters e a BullMQ reemite nelas todo erro
// da conexao Redis (QueueBase faz `connection.on("error", ... this.emit("error"))`).
// Um "error" sem listener em EventEmitter e excecao nao capturada: com o Redis
// indisponivel ou reconectando, o processo da API morria de repente no meio da
// geracao de legendas - a tela ficava travada em "Processando" e a requisicao
// seguinte (inclusive o DELETE que cancela o disparo) falhava com "Failed to
// fetch". Quem precisa da disponibilidade do Redis ja a verifica onde importa
// (health check, falha de enqueue), entao aqui basta registrar o erro.
function withErrorLogging(instance, name, kind) {
  instance.on("error", (error) => {
    console.error(
      JSON.stringify({
        event: "queue.error",
        queue: name,
        kind,
        error_message: (error && error.message) || String(error),
      })
    );
  });

  return instance;
}

function createQueue(name, options = {}) {
  return withErrorLogging(new Queue(name, buildQueueOptions(options)), name, "queue");
}

function createWorker(name, processor, options = {}) {
  return withErrorLogging(
    new Worker(name, processor, {
      ...options,
      connection: getRedisConnection(),
    }),
    name,
    "worker"
  );
}

function createQueueEvents(name, options = {}) {
  return withErrorLogging(
    new QueueEvents(name, {
      ...options,
      connection: getRedisConnection(),
    }),
    name,
    "queue_events"
  );
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
