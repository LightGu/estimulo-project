/*
  Deposito temporario do anexo do Disparador Pontual, para que ele NAO viaje
  dentro do payload do job da BullMQ.

  O PROBLEMA.

  No disparo pontual agendado, o anexo em base64 ia dentro de `job.data.content`.
  Isso multiplicava o arquivo de tres formas ao mesmo tempo:

    1. POR GRUPO. Um job por grupo, cada um com a sua copia integral. Trinta
       grupos com um video de 100 MB = 3 GB no Redis para um unico disparo.

    2. POR ATUALIZACAO DE ESTADO. `job.updateData({ ...job.data, status })` grava
       o job data INTEIRO de novo, e o worker o chama pelo menos duas vezes por
       envio (ao entrar em "processing" e ao concluir/falhar). Ou seja, cada copia
       era reescrita ~3x: aqueles 3 GB viravam ~9 GB de escrita no Redis.

    3. NO DISCO. O Redis desta stack roda com `--appendonly yes`
       (infra/docker-compose.yml), entao todo esse base64 era gravado no AOF,
       dentro do volume `redis-data`.

  SOBRE A EXIGENCIA DE NAO PERSISTIR O ANEXO.

  Ha uma decisao explicita do projeto de que o arquivo anexado nunca seja
  persistido em disco nem no banco - so exista em RAM enquanto o envio esta em
  voo. O ponto 3 acima mostra que, no caminho AGENDADO, essa invariante ja estava
  quebrada, em silencio e da pior maneira: o arquivo ia para o AOF replicado em
  N copias e permanecia la enquanto o job existisse (removeOnComplete = 24h).

  E ela nao e' alcancavel nesse caminho: um envio marcado para daqui a horas
  exige que os bytes sobrevivam ao fim da requisicao, em algum lugar fora do
  processo da API. O que este modulo faz e' reduzir a exposicao ao minimo, SEM
  introduzir um meio novo de persistencia - continua sendo o mesmo Redis que ja
  guardava o dado:

    - UMA copia por arquivo, e nao uma por grupo (a chave e' o hash do
      conteudo, entao grupos do mesmo disparo compartilham a entrada);
    - as atualizacoes de estado do job deixam de reescrever o base64;
    - TTL explicito, entao a entrada expira mesmo se ninguem a liberar;
    - apagada assim que o ultimo grupo do lote e' enviado, em vez de acompanhar
      o ciclo de vida do job.

  O caminho SINCRONO (dispatchAdHoc) continua sem passar por aqui: nele os bytes
  vao direto para a Evolution dentro da requisicao, que e' exatamente o
  comportamento que a exigencia descreve, e nao ha nada a depositar.
*/
const crypto = require("node:crypto");

const { getRedisConnection } = require("../config/redis");

const SPOOL_KEY_PREFIX = "estimulo:media-spool:";
const PENDING_FIELD = "pending";
// Cobre com folga o horizonte de um agendamento pontual (a tela agenda para o
// mesmo dia) sem deixar o anexo no Redis por tempo indefinido. Quem consome
// apaga a entrada antes disso; o TTL e' a rede de seguranca para o lote que
// nunca chega a ser enviado (campanha cancelada, job removido a mao).
const DEFAULT_SPOOL_TTL_MS = 12 * 60 * 60 * 1000;

function resolveSpoolTtlMs() {
  const configured = Number(process.env.MEDIA_SPOOL_TTL_MS);

  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_SPOOL_TTL_MS;
  }

  return Math.trunc(configured);
}

/*
  Teto de espera por comando no Redis.

  A conexao compartilhada do projeto usa `maxRetriesPerRequest: null`
  (src/config/redis.js), o que faz o ioredis reenfileirar o comando
  INDEFINIDAMENTE enquanto o Redis nao responde. Sem um teto aqui, um Redis
  indisponivel nao produziria erro: produziria uma espera eterna dentro de
  prepareMediaAndEnqueue, com os logs presos em "pendente" e a tela girando para
  sempre - e o try/catch que existe la nunca seria alcancado.

  Com o teto, a indisponibilidade vira falha visivel: o lote e' marcado como
  "falhou" com motivo, que e' o desfecho que se consegue explicar.
*/
const DEFAULT_SPOOL_COMMAND_TIMEOUT_MS = 10 * 1000;

function resolveSpoolCommandTimeoutMs() {
  const configured = Number(process.env.MEDIA_SPOOL_COMMAND_TIMEOUT_MS);

  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_SPOOL_COMMAND_TIMEOUT_MS;
  }

  return Math.trunc(configured);
}

function withCommandTimeout(promise, operation, timeoutMs = resolveSpoolCommandTimeoutMs()) {
  let timeoutId;

  return Promise.race([
    // `finally` no lugar de then/catch: precisa limpar o timer tambem quando o
    // comando REJEITA, senao cada falha deixaria um timer pendente segurando o
    // event loop - o mesmo tipo de vazamento corrigido em ffmpeg-process.js.
    Promise.resolve(promise).finally(() => clearTimeout(timeoutId)),
    new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Redis nao respondeu em ${timeoutMs}ms ao ${operation} o anexo do envio`));
      }, timeoutMs);
    }),
  ]);
}

function buildSpoolKey(digest) {
  return `${SPOOL_KEY_PREFIX}${digest}`;
}

// Chave pelo conteudo, e nao por um id sorteado: dois grupos do mesmo disparo
// (e dois disparos do mesmo arquivo) compartilham uma unica entrada, que e' o
// ganho principal aqui.
function digestContent(content) {
  return crypto.createHash("sha256").update(content.base64).digest("hex").slice(0, 32);
}

function hasSpoolableMedia(content) {
  return Boolean(content) && typeof content.base64 === "string" && content.base64.length > 0;
}

/*
  Deposita o anexo e devolve a referencia que viaja no job.

  `consumers` e' quantos jobs vao ler esta entrada (um por grupo do lote). O
  contador existe para que o ultimo a enviar possa apagar o anexo em vez de
  esperar o TTL - e para que dois lotes do MESMO arquivo nao apaguem a entrada um
  do outro.
*/
async function putMediaInSpool(content, options = {}) {
  if (!hasSpoolableMedia(content)) {
    return null;
  }

  const redis = options.redis || getRedisConnection();
  const consumers = Math.max(1, Number(options.consumers) || 1);
  const ttlMs = options.ttlMs || resolveSpoolTtlMs();
  const digest = digestContent(content);
  const key = buildSpoolKey(digest);

  const pipeline = redis.multi();

  pipeline.hset(key, {
    base64: content.base64,
    mime_type: content.mimeType || "",
    file_name: content.fileName || "",
    type: content.type || "",
    created_at: new Date().toISOString(),
  });
  pipeline.hincrby(key, PENDING_FIELD, consumers);
  pipeline.pexpire(key, ttlMs);

  await withCommandTimeout(pipeline.exec(), "depositar");

  return {
    spool_key: digest,
    // Metadados ficam TAMBEM na referencia: sao poucos bytes e permitem ao
    // worker montar a mensagem de erro (nome e tipo do arquivo) mesmo quando a
    // entrada expirou e o base64 nao esta mais la.
    mime_type: content.mimeType || null,
    file_name: content.fileName || null,
    type: content.type || null,
    base64_bytes: content.base64.length,
  };
}

/*
  Le o anexo de volta, no worker, imediatamente antes do envio.

  Devolve null quando a entrada nao existe mais (TTL vencido, ou liberada por um
  lote que terminou antes). Quem chama trata isso como falha do envio - com
  motivo registrado -, e nao como "envie so o texto": um anexo que desaparece
  silenciosamente entregaria ao grupo uma mensagem diferente da que foi
  agendada.
*/
async function readMediaFromSpool(reference, options = {}) {
  const spoolKey = typeof reference === "string" ? reference : reference && reference.spool_key;

  if (!spoolKey) {
    return null;
  }

  const redis = options.redis || getRedisConnection();
  const stored = await withCommandTimeout(redis.hgetall(buildSpoolKey(spoolKey)), "ler");

  if (!stored || !stored.base64) {
    return null;
  }

  return {
    base64: stored.base64,
    mimeType: stored.mime_type || (reference && reference.mime_type) || null,
    fileName: stored.file_name || (reference && reference.file_name) || null,
    type: stored.type || (reference && reference.type) || null,
  };
}

/*
  Baixa o contador e apaga a entrada quando o ultimo consumidor termina.

  Chamado em qualquer desfecho do envio - sucesso, falha ou cancelamento -,
  porque o que interessa e' que aquele job nao vai mais ler o anexo. Best-effort:
  nao apagar e' recuperavel pelo TTL, entao um erro aqui nunca pode derrubar um
  envio que ja aconteceu.
*/
async function releaseMediaFromSpool(reference, options = {}) {
  const spoolKey = typeof reference === "string" ? reference : reference && reference.spool_key;

  if (!spoolKey) {
    return { released: false };
  }

  const redis = options.redis || getRedisConnection();
  const key = buildSpoolKey(spoolKey);
  const pending = await withCommandTimeout(redis.hincrby(key, PENDING_FIELD, -1), "liberar");

  if (pending <= 0) {
    await withCommandTimeout(redis.del(key), "apagar");

    return { released: true, deleted: true, pending: 0 };
  }

  return { released: true, deleted: false, pending };
}

module.exports = {
  DEFAULT_SPOOL_COMMAND_TIMEOUT_MS,
  DEFAULT_SPOOL_TTL_MS,
  SPOOL_KEY_PREFIX,
  buildSpoolKey,
  digestContent,
  hasSpoolableMedia,
  putMediaInSpool,
  readMediaFromSpool,
  releaseMediaFromSpool,
  resolveSpoolCommandTimeoutMs,
  resolveSpoolTtlMs,
  withCommandTimeout,
};
