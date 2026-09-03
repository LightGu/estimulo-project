const { Queue, QueueEvents, Worker } = require("bullmq");

const { closeRedisConnection, getRedisConnection } = require("../config/redis");
const { Sentry } = require("../config/sentry");

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
    Sentry.captureException(error, { tags: { queue: name, kind } });
  });

  return instance;
}

function createQueue(name, options = {}) {
  return withErrorLogging(new Queue(name, buildQueueOptions(options)), name, "queue");
}

// Escuta "failed" aqui (em vez de exigir que cada script registre o proprio
// listener) para nenhuma fila esquecer de mandar a falha do job pro Sentry -
// erro de negocio dentro do processor, apos esgotar as tentativas, e' o tipo de
// falha que hoje so aparece se alguem for procurar no log.
function createWorker(name, processor, options = {}) {
  const worker = withErrorLogging(
    new Worker(name, processor, {
      ...options,
      connection: getRedisConnection(),
    }),
    name,
    "worker"
  );

  worker.on("failed", (job, error) => {
    Sentry.captureException(error, {
      tags: { queue: name, kind: "job_failed" },
      extra: { job_id: job && job.id, job_data: job && job.data, attempts_made: job && job.attemptsMade },
    });
  });

  return worker;
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
