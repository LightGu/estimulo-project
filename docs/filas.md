# Filas com BullMQ

O projeto usa BullMQ sobre Redis para processar tarefas assincronas, como
agendamentos, distribuicao de conteudos e integracoes futuras.

## Configuracao centralizada

As variaveis de conexao ficam no `.env`:

```env
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_USERNAME=default
REDIS_PASSWORD=redis-local
REDIS_DB=0
```

O modulo `src/config/redis.js` concentra a configuracao e expoe uma conexao
compartilhada com Redis por meio de `getRedisConnection()`.

## Criacao de filas

Use sempre os helpers de `src/queues/bullmq.js` para criar `Queue`, `Worker` e
`QueueEvents`. Eles reaproveitam a conexao compartilhada com Redis e aplicam
opcoes padrao de retry e limpeza de jobs.

Observacao: `Worker` e `QueueEvents` usam operacoes bloqueantes no Redis. O
BullMQ pode duplicar internamente a conexao recebida para essas operacoes, mas
a aplicacao deve continuar passando pela configuracao centralizada para evitar
clientes Redis criados de forma dispersa.

```js
const {
  createQueue,
  createQueueEvents,
  createWorker,
} = require("../queues/bullmq");

const queueName = "content-distribution";

const contentDistributionQueue = createQueue(queueName);

const contentDistributionWorker = createWorker(queueName, async (job) => {
  const { contentId, recipientId } = job.data;

  // Processar envio do conteudo aqui.
  return { contentId, recipientId };
});

const contentDistributionEvents = createQueueEvents(queueName);

contentDistributionEvents.on("completed", ({ jobId }) => {
  console.log(`Job ${jobId} finalizado`);
});

module.exports = {
  contentDistributionEvents,
  contentDistributionQueue,
  contentDistributionWorker,
};
```

## Adicao de jobs

```js
await contentDistributionQueue.add("send-content", {
  contentId: "content-123",
  recipientId: "user-456",
});
```

## Fila campaign-trigger

A fila `campaign-trigger` inicia o processamento assincrono de campanhas de
envio de conteudos. Use o modulo `src/queues/campaign-trigger.js` para adicionar
jobs sem instanciar BullMQ diretamente.

Cada job contem pelo menos:

- `campaign_id`: identificador da campanha.
- `execution_at`: data/hora planejada para execucao em ISO 8601.
- `status`: status inicial do processamento, por padrao `pending`.

```js
const { addCampaignTriggerJob } = require("../src/queues/campaign-trigger");

await addCampaignTriggerJob({
  campaign_id: "campaign-123",
  execution_at: new Date(),
});
```

Quando houver processamento de campanha implementado, crie o worker pelo mesmo
modulo:

```js
const { createCampaignTriggerWorker } = require("../src/queues/campaign-trigger");

const worker = createCampaignTriggerWorker(async (job) => {
  const { campaign_id, execution_at, status } = job.data;

  // Buscar grupos, etapas e conteudos da campanha aqui.
  return { campaign_id, execution_at, status };
});
```

Para testar manualmente com o Redis local ativo:

```bash
npm run queue:campaign-trigger:test -- campaign-123
```

Tambem e possivel informar uma data/hora de execucao:

```bash
npm run queue:campaign-trigger:test -- campaign-123 2026-07-09T15:00:00.000Z
```

Quando a data informada estiver no futuro, o job sera adicionado com `delay`
nativo do BullMQ.

Para jobs agendados ou repetiveis, use as opcoes nativas do BullMQ:

```js
await contentDistributionQueue.add(
  "daily-content-distribution",
  { campaignId: "campaign-123" },
  {
    repeat: {
      pattern: "0 9 * * *",
    },
  }
);
```

## Encerramento

Em processos longos, registre handlers de encerramento para fechar workers,
eventos e a infraestrutura compartilhada:

```js
const { closeQueueInfrastructure } = require("../queues/bullmq");

async function shutdown() {
  await contentDistributionWorker.close();
  await contentDistributionEvents.close();
  await contentDistributionQueue.close();
  await closeQueueInfrastructure();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

Evite instanciar `new Queue`, `new Worker`, `new QueueEvents` ou `new IORedis`
diretamente em outros modulos da aplicacao. Isso mantem a conexao com Redis
centralizada e reduz conexoes desnecessarias.
