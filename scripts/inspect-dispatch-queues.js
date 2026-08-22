// Diagnostico das filas de envio no Redis.
//
// Existe porque o Redis da infra sobe com `--appendonly yes` e volume
// persistente: todo job de envio que nao terminou continua gravado entre
// `docker compose down` e o proximo `up`. Quando os workers voltam, a BullMQ
// promove de uma vez todos os jobs `delayed` cujo horario ja passou e reentrega
// os que ficaram `active` no shutdown - e um envio agendado para dias atras sai
// como se fosse agora. Este script mostra exatamente o que esta armado antes de
// subir os workers, e com `--purge` remove o que estiver vencido.
//
// Uso (host, com o Redis da infra acessivel):
//   node scripts/inspect-dispatch-queues.js
//   node scripts/inspect-dispatch-queues.js --purge          # remove jobs vencidos
//   node scripts/inspect-dispatch-queues.js --purge --repeat # remove tambem os agendamentos recorrentes
//
// Dentro do compose (quando o Redis nao esta publicado no host):
//   docker compose -f infra/docker-compose.yml run --rm --entrypoint node api \
//     scripts/inspect-dispatch-queues.js

require("dotenv").config({ quiet: true });

const IORedis = require("ioredis");
const { Queue } = require("bullmq");

const { redisConfig } = require("../src/config/redis");
const { queueNames } = require("../src/queues/names");
const { resolveMaxDispatchDelayMs } = require("../src/services/dispatch-staleness");

// Conexao propria, com falha rapida.
//
// A conexao compartilhada (src/config/redis.js) usa maxRetriesPerRequest: null
// de proposito: um worker deve reconectar para sempre. Para uma ferramenta de
// linha de comando isso e o pior comportamento possivel - sem Redis acessivel o
// script fica pendurado sem dizer nada, em vez de avisar que nao conseguiu
// conectar. Aqui o certo e desistir e explicar.
let connection;

function getInspectConnection() {
  if (!connection) {
    connection = new IORedis({
      ...redisConfig,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      connectTimeout: 5000,
      retryStrategy: () => null,
    });

    connection.on("error", () => {
      // Tratado no catch do main, com mensagem util.
    });
  }

  return connection;
}

// Filas cujos jobs resultam em mensagem real no WhatsApp. group-sync e
// google-drive-video-index ficam de fora de proposito: sao leitura/indexacao.
const SEND_QUEUES = [
  queueNames.dispatch,
  queueNames.mensagensDispatch,
  queueNames.campaignTrigger,
  queueNames.dispatchFailureRetry,
  queueNames.dispatchReviewTimeout,
];

const PURGE = process.argv.includes("--purge");
const PURGE_REPEATABLE = process.argv.includes("--repeat");

function resolveJobScheduledAt(job) {
  const data = (job && job.data) || {};

  return data.scheduled_at || data.execution_at || null;
}

function describeJob(job, nowMs, maxDelayMs) {
  const scheduledAt = resolveJobScheduledAt(job);
  const scheduledMs = scheduledAt ? new Date(scheduledAt).getTime() : null;
  const hasSchedule = Number.isFinite(scheduledMs);
  const lateMs = hasSchedule ? nowMs - scheduledMs : null;

  return {
    job_id: job.id,
    name: job.name,
    campaign_id: job.data && job.data.campaign_id,
    group_id: job.data && job.data.group_id,
    video_id: job.data && job.data.video_id,
    dispatch_log_id: job.data && job.data.dispatch_log_id,
    status_no_job: job.data && job.data.status,
    scheduled_at: scheduledAt,
    // "sem horario" e o caso mais perigoso: a trava de atraso nao tem contra o
    // que comparar, entao antes da correcao esse job passava direto.
    atraso_min: hasSchedule ? Math.floor(lateMs / 60000) : "sem horario",
    vencido: hasSchedule ? lateMs > maxDelayMs : true,
  };
}

async function inspectQueue(name, nowMs, maxDelayMs) {
  const queue = new Queue(name, { connection: getInspectConnection() });

  // Queue e um EventEmitter e a BullMQ reemite nele todo erro da conexao Redis.
  // Sem listener, um "error" em EventEmitter vira excecao nao capturada e o
  // script morre com stack trace em vez da mensagem util do catch do main.
  queue.on("error", () => {});

  try {
    const [waiting, delayed, active, paused, repeatable, counts] = await Promise.all([
      queue.getJobs(["waiting"], 0, 500),
      queue.getJobs(["delayed"], 0, 500),
      queue.getJobs(["active"], 0, 500),
      queue.getJobs(["paused"], 0, 500),
      queue.getRepeatableJobs().catch(() => []),
      queue.getJobCounts().catch(() => ({})),
    ]);

    const pending = [...waiting, ...delayed, ...active, ...paused];
    const described = pending.map((job) => describeJob(job, nowMs, maxDelayMs));
    const overdue = described.filter((entry) => entry.vencido);

    console.log(
      JSON.stringify(
        {
          event: "queue_inspect",
          queue: name,
          counts,
          pendentes: described.length,
          vencidos: overdue.length,
          agendamentos_recorrentes: repeatable.map((entry) => ({
            key: entry.key,
            name: entry.name,
            pattern: entry.pattern,
            every: entry.every,
            next: entry.next ? new Date(entry.next).toISOString() : null,
          })),
        },
        null,
        2
      )
    );

    if (overdue.length) {
      console.log(
        JSON.stringify({ event: "queue_inspect.jobs_vencidos", queue: name, jobs: overdue }, null, 2)
      );
    }

    if (PURGE) {
      let removed = 0;

      for (const job of pending) {
        const described = describeJob(job, nowMs, maxDelayMs);

        if (!described.vencido) {
          continue;
        }

        // `remove()` recusa job em estado active para nao matar um envio em
        // andamento; nesse caso so registra - o job cai na trava de atraso do
        // worker, que agora cancela em vez de enviar.
        try {
          await job.remove();
          removed += 1;
          console.log(JSON.stringify({ event: "queue_inspect.job_removido", queue: name, ...described }));
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "queue_inspect.job_remocao_falhou",
              queue: name,
              job_id: job.id,
              error_message: error.message,
            })
          );
        }
      }

      if (PURGE_REPEATABLE) {
        for (const entry of repeatable) {
          await queue.removeRepeatableByKey(entry.key).catch(() => undefined);
          console.log(
            JSON.stringify({ event: "queue_inspect.recorrente_removido", queue: name, key: entry.key })
          );
        }
      }

      console.log(JSON.stringify({ event: "queue_inspect.purge_concluido", queue: name, removidos: removed }));
    }

    return { queue: name, pendentes: described.length, vencidos: overdue.length };
  } finally {
    await queue.close();
  }
}

async function main() {
  const nowMs = Date.now();
  const maxDelayMs = resolveMaxDispatchDelayMs();

  // Preflight: confirma a conexao ANTES de montar as filas, para que problema de
  // rede/senha chegue no catch do main (com instrucao de como rodar) em vez de
  // vazar como excecao de dentro da BullMQ.
  await getInspectConnection().ping();

  console.log(
    JSON.stringify({
      event: "queue_inspect.iniciado",
      agora: new Date(nowMs).toISOString(),
      max_atraso_min: Math.floor(maxDelayMs / 60000),
      purge: PURGE,
      purge_recorrentes: PURGE_REPEATABLE,
      redis_host: process.env.REDIS_HOST || "localhost",
      redis_db: Number(process.env.REDIS_DB || 0),
    })
  );

  const summary = [];

  for (const name of SEND_QUEUES) {
    summary.push(await inspectQueue(name, nowMs, maxDelayMs));
  }

  console.log(JSON.stringify({ event: "queue_inspect.resumo", filas: summary }, null, 2));
}

main()
  .catch((error) => {
    const message = error && error.message ? error.message : String(error);
    const looksLikeConnectionProblem =
      /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|Connection is closed|NOAUTH|WRONGPASS|max retries/i.test(message);

    console.error(JSON.stringify({ event: "queue_inspect.falhou", error_message: message }));

    if (looksLikeConnectionProblem) {
      console.error(
        [
          "",
          `Nao consegui falar com o Redis em ${redisConfig.host}:${redisConfig.port} (db ${redisConfig.db}).`,
          "",
          "O compose nao publica a porta do Redis no host, entao rodar direto da sua maquina so funciona",
          "se voce tiver exposto a porta. O caminho que sempre funciona e rodar de dentro da rede do compose:",
          "",
          "  docker compose -f infra/docker-compose.yml run --rm --entrypoint node api \\",
          "    scripts/inspect-dispatch-queues.js",
          "",
          "Confira tambem REDIS_HOST / REDIS_PORT / REDIS_PASSWORD no .env.",
          "",
        ].join("\n")
      );
    }

    process.exitCode = 1;
  })
  .finally(async () => {
    if (connection) {
      await connection.quit().catch(() => connection.disconnect());
    }
  });
