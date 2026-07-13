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
jobs sem instanciar BullMQ diretamente. Ela suporta execucoes pontuais e
agendamentos recorrentes por campanha.

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

### Agendamento recorrente de campanhas

Use `scheduleCampaign()` para criar ou atualizar um job repetivel na fila
`campaign-trigger`. A chave do agendamento e deterministica por campanha e usa o
formato `campaign-trigger-<campaign_id_url_encoded>`, compatível com a restricao
do BullMQ para chaves customizadas. Chamar a funcao novamente para a mesma
campanha atualiza o agendamento existente.

```js
const {
  disableCampaignSchedule,
  removeCampaignSchedule,
  scheduleCampaign,
} = require("../src/queues/campaign-trigger");

await scheduleCampaign({
  campaign_id: "campaign-123",
  cron_expression: "0 9 * * 1-5",
  timezone: "America/Bahia",
  window_start: "09:00",
  window_end: "18:00",
  jitter_delay_min_ms: 60_000,
  jitter_delay_max_ms: 300_000,
  active: true,
});

await disableCampaignSchedule({
  campaign_id: "campaign-123",
});

await removeCampaignSchedule({
  campaign_id: "campaign-123",
});
```

Tambem e possivel usar uma regra em milissegundos:

```js
await scheduleCampaign({
  campaign_id: "campaign-123",
  recurrence_rule: {
    every: 1000 * 60 * 60 * 24,
    limit: 10,
  },
});
```

Cada job recorrente contem dados suficientes para o worker identificar e
processar a campanha:

- `campaign_id`: identificador da campanha.
- `schedule_key`: chave repetivel usada pelo BullMQ.
- `trigger_type`: `recurring`.
- `recurrence`: cron, intervalo, fuso, limite e datas de inicio/fim.
- `time_window`: janela operacional opcional.
- `dispatch_jitter`: faixa opcional de atraso randomico entre envios, em
  milissegundos.
- `active` e `status`: estado do agendamento.
- `dispatch_queue`: nome da fila `dispatch`, para o processador da campanha
  preparar os envios individuais via `addDispatchJob()`.

Quando uma campanha for marcada como inativa, chame `disableCampaignSchedule()`
ou `scheduleCampaign({ campaign_id, active: false })`. Ambas as formas removem o
job repetivel da fila.

Para testar manualmente:

```bash
npm run queue:campaign-trigger:test -- campaign-123 --cron "0 9 * * 1-5" --timezone America/Bahia --window-start 09:00 --window-end 18:00 --jitter-min-ms 60000 --jitter-max-ms 300000
```

Para remover o agendamento:

```bash
npm run queue:campaign-trigger:test -- campaign-123 --remove
```

## Fila dispatch

A fila `dispatch` processa os envios individuais de conteudos para grupos. Ela
recebe jobs preparados pela `campaign-trigger` e executa cada entrega de forma
isolada, sem interromper os demais envios quando um job falha.

Use o modulo `src/queues/dispatch.js` para adicionar jobs:

```js
const { addDispatchJob } = require("../src/queues/dispatch");

await addDispatchJob({
  group_id: "120363000000000000@g.us",
  campaign_id: "campaign-123",
  link_video: "https://example.com/video.mp4",
  legenda: "Conteudo da campanha",
  scheduled_at: new Date(),
});
```

Para campanhas com mais de um grupo, use `addJitteredDispatchJobs()` no
processador da campanha. A funcao preserva a ordem recebida em `groups`, agenda
o primeiro grupo no inicio da janela e soma um atraso randomico entre
`jitter_delay_min_ms` e `jitter_delay_max_ms` antes de cada proximo grupo. O
calculo ajusta o limite superior de cada sorteio para manter todos os envios
dentro de `window_start` e `window_end`; quando a janela nao comporta a faixa
minima configurada, a funcao falha antes de enfileirar.

```js
const { addJitteredDispatchJobs } = require("../src/queues/dispatch");

await addJitteredDispatchJobs({
  campaign_id: "campaign-123",
  link_video: "https://example.com/video.mp4",
  legenda: "Conteudo da campanha",
  groups: [
    "120363000000000001@g.us",
    "120363000000000002@g.us",
    "120363000000000003@g.us",
  ],
  window_start: "09:00",
  window_end: "18:00",
  jitter_delay_min_ms: 60_000,
  jitter_delay_max_ms: 300_000,
});
```

Cada job contem pelo menos:

- `group_id`: identificador do grupo de destino.
- `campaign_id`: campanha associada ao envio.
- `link_video`: URL do video que sera enviado.
- `legenda`: texto usado como legenda/mensagem.
- `scheduled_at`: data/hora planejada para envio em ISO 8601.
- `status`: status inicial do processamento, por padrao `pending`.
- `dispatch_order`, `jitter_delay_ms` e `cumulative_delay_ms`: metadados
  preenchidos quando o job foi criado por `addJitteredDispatchJobs()`.

O worker padrao chama o wrapper `sendToEvolution` de
`src/services/evolution.js`. Ao iniciar, o job tem `status` atualizado para
`processing` e recebe `started_at`. Em sucesso, o job tem `status` atualizado
para `sent`, recebe `completed_at` e retorna os dados do provedor. Em erro, o
job tem `status` atualizado para `failed`, registra `failed_at` e
`error_message`, e relanca a excecao para o BullMQ marcar a tentativa como
falha. Por padrao, jobs da `dispatch` usam uma unica tentativa; retries podem
ser configurados nas opcoes do job quando necessario.

Para iniciar o worker:

```bash
npm run queue:dispatch:worker
```

Para testar um envio manual para um grupo de teste com o Redis local ativo:

```bash
npm run queue:dispatch:test -- 120363000000000000@g.us campaign-123 https://example.com/video.mp4 "Legenda de teste"
```

Tambem e possivel informar uma data/hora de envio:

```bash
npm run queue:dispatch:test -- 120363000000000000@g.us campaign-123 https://example.com/video.mp4 "Legenda de teste" 2026-07-10T15:00:00.000Z
```

Quando a data informada estiver no futuro, o job sera adicionado com `delay`
nativo do BullMQ.

Para trocar o envio real por simulacao ou outro provedor no futuro, injete uma
funcao `sender` ao criar o worker:

```js
const { createDispatchWorker } = require("../src/queues/dispatch");

const worker = createDispatchWorker({
  sender: async (payload) => ({
    provider: "simulated",
    status: 200,
    payload,
  }),
});
```

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
