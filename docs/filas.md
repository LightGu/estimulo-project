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

O worker padrao da campanha busca os grupos associados em `campaign_groups`,
filtra `groups.envia_video = true`, resolve o proximo video elegivel por grupo
considerando `group_video_progress` e enfileira os envios na fila `dispatch`.
Para iniciar o worker:

```bash
npm run queue:campaign-trigger:worker
```

### Resolucao do proximo video por grupo

Antes de enfileirar jobs na `dispatch`, o processador da campanha deve resolver
o fluxo de videos com `src/services/group-video-flow.js`. A versao atual prioriza
`groups.trilha_id` e usa a tabela `trilha_videos` para descobrir quais videos
fazem parte da trilha e em qual ordem aparecem. O servico considera apenas
videos aprovados (`video_catalog.status = true`), ignora videos ja enviados ao
grupo em `group_video_progress` e retorna o primeiro disponivel de acordo com
`trilha_videos.ordem`.

Quando nao existe mais video aprovado e ainda nao enviado para a trilha do
grupo, o servico pausa o grupo no fluxo de videos com o motivo
`end_of_queue`. Essa pausa evita reenfileirar conteudo repetido. Grupos com
`envia_video = false` sao ignorados antes da selecao de conteudo, mesmo que
estejam pausados por `end_of_queue`, e nao entram na fila de dispatch.

```js
const {
  resolveGroupsVideoFlow,
} = require("../src/services/group-video-flow");

const result = await resolveGroupsVideoFlow({
  campaign_id: "campaign-123",
  groups,
  repository: videoFlowRepository,
  logger: console,
});

await addJitteredDispatchJobs({
  campaign_id: "campaign-123",
  legenda: "Conteudo da campanha",
  groups: result.dispatchGroups,
  window_start: "09:00",
  window_end: "18:00",
  jitter_delay_min_ms: 60_000,
  jitter_delay_max_ms: 300_000,
});
```

O repositorio injetado pode implementar:

- `findNextApprovedUnsentVideoForGroup(group)`: busca o proximo video elegivel.
- `pauseGroupVideoFlowForEndOfQueue(groupId, metadata)`: marca a pausa por fim
  de fila.
- `resumeGroupVideoFlow(groupId, metadata)`: remove a pausa quando houver novo
  video elegivel.

Quando um grupo entra em pausa por fim de fila, o servico registra um log JSON
com `event = "group_video_flow.paused_end_of_queue"`, `campaign_id`, `group_id`,
`dispatch_group_id`, `trilha_segmento`, `pause_reason` e `paused_at`. O log e
emitido apenas na transicao para a pausa, nao em ciclos posteriores em que o
grupo ja esta pausado pelo mesmo motivo.

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

## Fila campaign-captions

Gera as legendas da Etapa 2 de uma campanha de video e, quando a revisao humana
esta desligada nas configuracoes, confirma o disparo em seguida.

### Por que ela existe

Ate aqui a geracao era uma promise solta no processo da API, disparada por
`campaigns.service.js -> dispatchCampaign`:

```js
campaignVideoCaptionsService
  .generateCaptionsForCampaign(campaign.id)
  .then(() => maybeAutoConfirmDispatch(...))
  .catch((error) => console.error(...));
```

A campanha nascia em `gerando_legendas` e **so aquela promise podia tira-la de
la**. Consequencias:

- **Todo deploy abandonava a geracao em andamento.** O deploy recria o container
  `api`; a promise morria com ele e a campanha ficava presa em
  `gerando_legendas` para sempre - sem retry e sem estado de onde retomar. O
  sweep de `dispatch-review-timeout` tambem nao a resgatava, porque
  `auto_send_after_timeout` vem desligado por padrao (isso foi corrigido em
  separado: hoje a deteccao roda sempre e notifica, mas notificar nao gera
  legenda).
- **O trabalho pesado rodava na API.** Download do Drive, ffmpeg, transcricao e
  chamada ao Gemini por grupo, no mesmo event loop que atende requisicoes.
- **Sem teto de concorrencia.** Duas campanhas despachadas juntas eram dois
  lacos simultaneos, os dois consumindo a mesma cota diaria do Gemini.
- **Erro so em `console.error`.** Sem tentativas, sem Sentry (o `createWorker`
  manda `failed` para o Sentry; uma promise solta nao manda nada).

### Desenho

| Aspecto | Escolha | Por que |
| --- | --- | --- |
| `jobId` | `captions\|<campaign_id>` | A BullMQ recusa em silencio um `add()` com id repetido, e e' essa recusa que impede dois lacos de geracao sobre as mesmas linhas (dois cliques em "Disparar"). |
| `attempts` | 3, backoff exponencial de 60s | A falha tipica e' cota do Gemini (429), que nao passa em segundos. |
| `concurrency` | 1 (`CAMPAIGN_CAPTIONS_CONCURRENCY`) | A cota do Gemini e' global do projeto, nao por campanha: paralelizar nao termina antes, so esgota a cota mais cedo. |
| `lockDuration` | 45 min (`CAMPAIGN_CAPTIONS_JOB_LOCK_MS`) | A geracao percorre os grupos em serie e cada um pode baixar video, extrair audio e chamar o Gemini. |

### O que tornou o retry seguro

Retentar so faz sentido porque `generateCaptionsForCampaign` aceita
`{ resume: true }` e **preserva as linhas ja em `gerado`**.

Sem isso o retry causaria dano em vez de resolver: `createManyPending` e' um
upsert com `status: "pendente", erro_mensagem: null`, ou seja, a segunda
tentativa devolveria a campanha inteira para a fila - gastando a cota do Gemini
de novo e descartando texto que o usuario tivesse ajustado a mao na Etapa 2.
`erro` e `processando` continuam voltando para a fila de proposito: o primeiro
e' o que a retentativa existe para consertar, e o segundo e' uma geracao
interrompida no meio, sem resultado a aproveitar.

O `caption_id` das linhas preservadas segue reservado na retomada, para que um
grupo nao receba a legenda que outro grupo da mesma campanha ja recebeu.

### Desfechos do job

| Situacao | Desfecho | Por que nao relanca |
| --- | --- | --- |
| Campanha apagada | `skipped` | Retentar tres vezes contra uma linha que nao existe. |
| Campanha cancelada/ja confirmada na espera | `skipped` | Gerar legenda agora e' cota gasta para nada. |
| Alguma linha em `erro` | `partial` | A linha esta registrada e visivel na Etapa 2, e `notifyAiError` ja avisou; relancar regeraria os videos que deram certo. |
| Confirmacao automatica falhou | `completed`, `auto_confirm: "failed"` | A geracao terminou; o problema e' da janela de envio, e a tela permite confirmar a mao. |
| Geracao incompleta sem erro | **relanca** | E' interrupcao no meio do laco - o unico caso em que retentar ajuda. Na ultima tentativa, notifica na tela. |

### Se o Redis estiver fora

`POST /campaigns/dispatch` responde **503** com `CAMPAIGN_CAPTIONS_ENQUEUE_FAILED`
e o id da campanha. A campanha fica criada em `gerando_legendas`, e repetir o
disparo depois resolve. Antes, essa mesma indisponibilidade produzia 200 seguido
de silencio.

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
- `link_video`, `video_id` ou `drive_file_id`: referencia do video que sera enviado.
- `legenda`: texto inicial usado como fallback quando nao houver legenda
  selecionada ou gerada pelo pipeline do worker.
- `scheduled_at`: data/hora planejada para envio em ISO 8601.
- `status`: status inicial do processamento, por padrao `pending`.
- `dispatch_order`, `jitter_delay_ms` e `cumulative_delay_ms`: metadados
  preenchidos quando o job foi criado por `addJitteredDispatchJobs()`.

Quando o job recebe `video_id` ou `video_catalog`, o worker inicia em paralelo o
download do arquivo do Google Drive e a obtencao da legenda. O servico
`downloadFromDrive()` usa o `drive_file_id` do registro `video_catalog`, chama
`drive.files.get({ fileId, alt: "media" })` e retorna os bytes junto com nome e
tipo MIME para o dispatcher montar o payload de envio. Em paralelo, o pipeline de
legendas seleciona uma legenda ainda nao usada no dia ou gera uma nova via IA,
seguida de revisao factual quando houver `video_id`. Se o download falhar, vier
vazio, nao representar um video, ou a legenda nao passar pela selecao/geracao e
revisao exigidas, o envio para a Evolution API nao e chamado. Apos a chamada ao
provedor, as referencias temporarias aos bytes/base64 sao liberadas. O envio por
`link_video` continua disponivel para testes manuais e fluxos antigos.

O worker padrao chama o wrapper `sendToEvolution` de
`src/services/evolution.js`. Ao iniciar, o job tem `status` atualizado para
`processing` e recebe `started_at`. Em sucesso, o job tem `status` atualizado
para `sent`, recebe `completed_at`, registra `group_video_progress` quando o job
tem `progress_group_id` e `video_id`, e retorna os dados do provedor. Em erro, o
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

## Anexo do disparo pontual: deposito em vez de payload

O anexo do Disparador Pontual (upload de imagem/video) ia em base64 **dentro de
`job.data.content`** na fila `mensagens-dispatch`. Isso multiplicava o arquivo de
tres maneiras ao mesmo tempo:

| Multiplicador | Por que | Efeito com video de 100 MB para 30 grupos |
| --- | --- | --- |
| Por grupo | Um job por grupo, cada um com a sua copia | ~3 GB |
| Por atualizacao de estado | `job.updateData({ ...job.data, status })` reescreve o job data INTEIRO, e o worker chama isso 2-3x por envio | ~9 GB de escrita |
| Em disco | O Redis da stack roda com `--appendonly yes` | tudo isso no AOF, no volume `redis-data` |

### Sobre a exigencia de nao persistir o anexo

O projeto tem uma decisao explicita de que o arquivo anexado nunca seja
persistido em disco nem no banco. A terceira linha da tabela mostra que, **no
caminho agendado, essa invariante ja estava quebrada** - em silencio e da pior
forma possivel: N copias no AOF, mantidas enquanto o job existisse
(`removeOnComplete` de 24h).

E ela nao e' alcancavel nesse caminho: um envio marcado para daqui a horas exige
que os bytes sobrevivam ao fim da requisicao, fora do processo da API.

O que `src/services/media-spool.js` faz e' reduzir a exposicao ao minimo **sem
introduzir um meio novo de persistencia** - continua sendo o mesmo Redis:

- **uma** copia por arquivo, chaveada pelo SHA-256 do conteudo (grupos do mesmo
  lote, e disparos diferentes do mesmo arquivo, compartilham a entrada);
- as atualizacoes de estado do job nao reescrevem mais o anexo;
- TTL explicito (`MEDIA_SPOOL_TTL_MS`, 12h por padrao);
- apagado assim que o **ultimo** grupo do lote termina, por contador de
  consumidores - sem esperar o TTL.

O caminho **sincrono** (`POST /mensagens/dispatch`) nao passa por aqui: nele os
bytes vao direto para a Evolution dentro da requisicao, que e' exatamente o
comportamento que a exigencia descreve.

### Decisoes que valem registrar

- **Anexo ausente FALHA o envio.** Se a entrada expirou (job muito atrasado,
  Redis limpo), o worker nao manda "so o texto": ele falha com motivo nomeando o
  arquivo. Enviar a mensagem sem o anexo entregaria ao grupo algo diferente do
  que foi agendado, e ninguem saberia.
- **Ha teto de espera por comando** (`MEDIA_SPOOL_COMMAND_TIMEOUT_MS`, 10s). A
  conexao compartilhada usa `maxRetriesPerRequest: null`, o que faz o ioredis
  reenfileirar o comando indefinidamente com o Redis fora - sem teto, uma
  indisponibilidade viraria espera eterna dentro do preparo, com os logs presos
  em "pendente" e a tela girando para sempre.
- **Jobs antigos continuam funcionando.** Um job enfileirado antes desta mudanca
  ainda carrega `content.base64`, e o worker o usa quando presente. Sem isso, o
  deploy cancelaria envios ja agendados.
- **O resume continua sem recuperar o anexo.** `requeuePendingMessages` reenvia
  so o texto quando o job original se perdeu do Redis durante uma pausa. O spool
  nao muda isso de proposito: quem sabe a chave do anexo e' o job, e e'
  justamente o job que se perdeu. Recuperar exigiria gravar a chave na campanha -
  um ponteiro persistente para o arquivo no banco -, que e' exatamente a decisao
  tomada em contrario.

## Fila google-drive-video-index

A fila `google-drive-video-index` percorre recursivamente a pasta raiz do Google
Drive e monta o catalogo de videos a partir da organizacao atual das pastas.
Falhas em uma pasta ou arquivo sao registradas no resultado do job e nao
interrompem a indexacao das demais pastas.

O indexador considera apenas arquivos de video validos. O arquivo e aceito
quando o `mimeType` do Drive comeca com `video/` ou quando a extensao e uma
extensao de video conhecida, como `mp4`, `mov`, `mkv`, `webm` ou `avi`.

### Indexacao incremental

O worker armazena o marco da ultima indexacao concluida com sucesso em
`storage/google-drive-video-index-state.json`, separado por `root_folder_id`.
Na primeira execucao, quando ainda nao existe estado salvo para a pasta raiz, a
leitura e completa. Nas execucoes seguintes, o job usa `modifiedTime` na query
do Google Drive para trazer apenas arquivos novos ou alterados depois do ultimo
marco salvo, mantendo as pastas na consulta para preservar a navegacao
recursiva.

Cada execucao consulta o periodo ate `started_at` do proprio job e salva esse
valor como `last_successful_index_at` apenas depois da conclusao com sucesso.
Os logs `google_drive_video_index.started` e
`google_drive_video_index.completed` informam `modified_time_after`,
`modified_time_before`, `processed_count`, `indexed_count`, `skipped_count` e
`error_count`.

A etapa e a trilha sao inferidas pelos nomes das pastas ancestrais do arquivo:

- etapa: pastas como `Etapa 01`, `Fase 2`, `Modulo 03`, `Semana 4`, `Aula 5`
  ou nomes iniciados por numero;
- trilha/persona: pastas que contenham `#P01`, `P01`, `Paulo`,
  `pre infancia`, `#M01`, `M01`, `Maria`, `#E01`, `E01`, `Eufrasio`,
  `adolescencia` ou `maturidade`.

Mapeamentos padrao:

| Hashtag | Persona | Trilha |
|---|---|---|
| `#P01` | Paulo | Empreendedores na pre infancia |
| `#M01` | Maria | Empreendedores na infancia |
| `#E01` | Eufrasio | Empreendedores na adolescencia e maturidade |

Para enfileirar uma indexacao:

```bash
npm run queue:drive-video-index:test
```

Tambem e possivel informar a pasta raiz manualmente:

```bash
npm run queue:drive-video-index:test -- --root-folder-id ID_DA_PASTA_RAIZ --root-folder-name Conteudos
```

Para iniciar o worker:

```bash
npm run queue:drive-video-index:worker
```

Ao iniciar, o worker tambem registra um repeatable job diario na mesma fila
`google-drive-video-index`, usando a infraestrutura de `src/queues/bullmq.js` e
a conexao Redis compartilhada. O agendamento usa a chave estavel
`google-drive-video-index-daily`, portanto reiniciar o worker atualiza o mesmo
agendamento em vez de criar duplicatas.

O horario fica centralizado no `.env`:

```env
GOOGLE_DRIVE_VIDEO_INDEX_CRON=0 3 * * *
GOOGLE_DRIVE_VIDEO_INDEX_TIMEZONE=America/Bahia
```

O cron acima executa uma vez por dia as 03:00 no fuso configurado. O job
recorrente usa as opcoes padrao da fila, incluindo a politica de tentativas e
backoff definida em `src/queues/bullmq.js`.

O inicio da execucao e registrado por `google_drive_video_index.execution_started`
e `google_drive_video_index.started`. Conclusao e falha sao registradas por
`google_drive_video_index.completed`, `google_drive_video_index.completed.event`,
`google_drive_video_index.failed` e `google_drive_video_index.failed.event`.

O worker usa `GOOGLE_DRIVE_CREDENTIALS` e `GOOGLE_DRIVE_ROOT_FOLDER_ID` do
`.env`. Enquanto o reposititorio de banco do catalogo nao estiver implementado,
o processor retorna os videos mapeados no resultado do job. Quando o banco
estiver disponivel, injete `upsertVideo(video)` em `createGoogleDriveVideoIndexWorker`
para gravar cada item no `video_catalog`.

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

## Operacao em producao

### Reenvio no boot: por que existem travas de atraso

O Redis da infra sobe com `--appendonly yes` e volume persistente, entao **todo
job de envio que nao terminou continua gravado entre um `docker compose down`
e o proximo `up`**. Quando os workers voltam, a BullMQ:

- promove de uma vez todos os jobs `delayed` cujo horario ja passou (rajada,
  todos com delay 0);
- reentrega os jobs que ficaram `active` no shutdown (stalled recovery);
- re-registra os agendamentos recorrentes (`dispatch-failure-retry`,
  `dispatch-review-timeout`), que voltam a rodar no instante do boot.

Sem trava, isso reenvia para os grupos de WhatsApp campanhas e mensagens
agendadas dias antes. As protecoes atuais:

| Trava | Onde | O que barra |
|---|---|---|
| Atraso do job (falha fechado) | `queues/dispatch.js`, `queues/mensagens-dispatch.js` | Job cujo `scheduled_at` passou do teto, ou que nao tem horario nenhum. |
| Atraso do trigger | `queues/campaign-trigger.js` | Trigger vencido virando dezenas de jobs com delay 0 (nao vale para campanha recorrente). |
| Campanha pausada/cancelada | `services/dispatch-consistency.service.js` + portao de `dispatch.js` | Job que sobreviveu no Redis depois de o operador pausar/cancelar. |
| Horario original preservado | `services/dispatch-staleness.js` (`resolveLogScheduledAt`) | Requeue/retry reestampando `scheduled_at` com "agora" e apagando a evidencia de atraso. |
| Teto de idade do auto-confirm | `queues/dispatch-review-timeout.js` | Campanha abandonada em `gerando_legendas` sendo ressuscitada e disparada inteira. |

Tetos configuraveis (ver `.env.example`): `MAX_DISPATCH_DELAY_MS` (30 min,
pontual), `MAX_VIDEO_DISPATCH_DELAY_MS` (6 h, video) e
`MAX_AUTO_CONFIRM_AGE_MS` (24 h). Aumentar demais reabre o risco de spam;
diminuir demais cancela envio legitimo de campanha grande, porque o worker de
video processa em serie.

Regressao coberta por `tests/dispatch-boot-replay.test.js`
(`npm run test:boot-replay`).

### Quem cancelou um envio, e quando

Um envio pode virar "Cancelado" por caminhos muito diferentes - o operador
clicando em cancelar, a trava de atraso barrando um job vencido, a cascata de
uma campanha cancelada - e na tabela `logs` os tres ficavam identicos. As
colunas que respondem isso hoje:

| Coluna | Onde | Resposta que ela da |
|---|---|---|
| `logs.cancelado_em` | `202609020002` | Quando aquele envio foi cancelado (a tabela nao tem `updated_at`). |
| `logs.cancelado_origem` | `202609020002` | `usuario` \| `atraso` \| `campanha_cancelada` \| `sistema` - vocabulario fechado por CHECK. |
| `logs.cancelado_por` / `campaigns.cancelado_por` | `202609030001` | A conta que pediu o cancelamento no painel. **Nula em cancelamento automatico**, onde nao existe responsavel. |
| `logs.atualizado_em` | `202609030002` | Instante da ultima alteracao do envio, mantido pelo trigger `trg_logs_atualizado_em`, ja que os envios sao atualizados por muitos caminhos diferentes (workers de video e de texto, retry, confirmacao de entrega, cascata de cancelamento) para um unico esquecimento nao reabrir o buraco. |

Onde isso aparece: o modal de campanha traz "Campanha cancelada em ... por
...''; o relatorio tem a coluna **Atualizado em** e o badge "Cancelado" carrega
na dica o motivo, a origem, o responsavel e o horario (`Detalhe do
cancelamento` no CSV, ja que planilha nao tem tooltip). O relatorio embeda o
responsavel com `app_users!logs_cancelado_por_fkey` - o nome da FK e'
obrigatorio, porque `logs` referencia `app_users` por duas colunas
(`usuario_responsavel_id` e `cancelado_por`) e sem desambiguar o Postgrest
recusa o embed inteiro.

Linhas anteriores a cada migration ficam **nulas de proposito**: o dado nunca
foi gravado e um backfill so trocaria um valor errado por outro. As telas
tratam esse nulo explicitamente - o modal de campanha mostra a data de criacao
dizendo que e' a de criacao, e a dica do relatorio omite o trecho de autoria
em vez de escrever "sem responsavel" (que soaria como "foi automatico",
justamente a conclusao errada).

Origem do problema e historico completo em
`docs/ERROS_E_APRENDIZADOS.md` ("Cancelamento sem auditoria"). Regressao
coberta por `tests/cancel-audit.test.js` (`npm run test:cancel-audit`).

### Suba o compose sempre com `--env-file`

`docker compose -f infra/docker-compose.yml ...` rodado da raiz do projeto
**nao le o `.env`**. O CLI do compose procura o `.env` relativo ao arquivo
passado em `-f` (ou seja `infra/.env`, que nao existe), e a interpolacao
`${VAR}` do proprio YAML resolve para **string vazia**, em silencio - apenas
warnings soltos. O `env_file: [../.env]` declarado dentro do YAML nao cobre
isso: ele alimenta o container depois de criado, nao a interpolacao do YAML.

O sintoma e traicoeiro: os containers sobem com `POSTGRES_USER=""`,
`REDIS_PASSWORD=""`, `AUTHENTICATION_API_KEY=""`, o Postgres recusa toda
conexao (`no PostgreSQL user name specified in startup packet`) e a Evolution
API entra em crash-loop.

Use os scripts npm, que ja passam o flag correto:

```bash
npm run infra:up          # redis + api
npm run infra:workers     # + workers de fila
npm run infra:evolution   # + Evolution API (gateway WhatsApp)
npm run infra:all         # tudo
npm run infra:ps          # status
npm run infra:logs        # logs de tudo
npm run infra:stop        # para sem remover
npm run infra:down        # para e remove
```

Manualmente, o equivalente e sempre:
`docker compose --env-file .env -f infra/docker-compose.yml ...`

### Reenvio automatico do Baileys (nao e a nossa fila)

Se mensagens sairem para grupos **sem que nada esteja nas nossas filas**
(`logs` com `falhou=0`/`pendente=0`, filas do Redis vazias), o envio
provavelmente nao veio da aplicacao. Procure no log da Evolution:

```bash
docker logs <container-evolution> 2>&1 | grep "sending message again"
```

`sendMessagesAgain` e o retry automatico do Baileys: quando um aparelho do
destinatario nao consegue descriptografar uma mensagem, ele pede reenvio ao
WhatsApp. Esses pedidos ficam acumulados **no servidor do WhatsApp** e sao
entregues quando a instancia reconecta - o Baileys entao reenvia a mensagem,
buscando o conteudo na tabela `Message` do Postgres da Evolution.

**Nao tente resolver apagando a tabela `Message`.** Sem o conteudo, o Baileys
nao pula o reenvio: ele envia uma **mensagem vazia** no lugar (testado em
2026-08-21 - 3 mensagens vazias chegaram a um grupo de cliente). As duas
pontas sao ruins: com conteudo, reenvia mensagem antiga; sem conteudo, envia
vazio.

A unica forma de encerrar o ciclo e **invalidar a sessao** que e dona daqueles
ids de mensagem (logout da instancia + novo pareamento por QR Code). Ai os
pedidos de reenvio pendentes passam a referenciar um dispositivo que nao
existe mais e sao descartados pelo WhatsApp.

### Inspecionar / limpar as filas antes de subir os workers

```bash
node scripts/inspect-dispatch-queues.js                  # so mostra o que esta armado
node scripts/inspect-dispatch-queues.js --purge          # remove os jobs vencidos
node scripts/inspect-dispatch-queues.js --purge --repeat # remove tambem os agendamentos recorrentes
```

Use antes de subir os workers quando houver suspeita de backlog antigo no
Redis. Dentro do compose (Redis nao publicado no host):

```bash
docker compose -f infra/docker-compose.yml run --rm --entrypoint node api scripts/inspect-dispatch-queues.js
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
