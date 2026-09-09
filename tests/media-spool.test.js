const assert = require("node:assert/strict");

const {
  DEFAULT_SPOOL_TTL_MS,
  SPOOL_KEY_PREFIX,
  digestContent,
  putMediaInSpool,
  readMediaFromSpool,
  releaseMediaFromSpool,
  resolveSpoolTtlMs,
} = require("../src/services/media-spool");
const { buildMensagensJobData, createMensagensDispatchProcessor } = require("../src/queues/mensagens-dispatch");
const { createMensagensService } = require("../src/services/mensagens.service");
const { closeQueueInfrastructure } = require("../src/queues/bullmq");

/*
  O anexo do Disparador Pontual agendado ia dentro do payload do job da BullMQ,
  o que o multiplicava tres vezes:

    - por grupo, porque ha um job por grupo;
    - por atualizacao de estado, porque `job.updateData({ ...job.data, status })`
      reescreve o job data INTEIRO, e o worker faz isso duas ou tres vezes por
      envio;
    - em disco, porque o Redis desta stack roda com `--appendonly yes`.

  Um video de 100 MB para 30 grupos escrevia da ordem de 9 GB no Redis num unico
  disparo - e gravava o anexo no AOF, contrariando na pratica a exigencia de que
  o arquivo nao seja persistido (ver o cabecalho de services/media-spool.js:
  no caminho agendado essa exigencia nao e' alcancavel, e o que este desenho faz
  e' reduzir a exposicao ao minimo sem introduzir um meio novo).

  O primeiro teste e' o que da sentido a todos os outros: o base64 nao esta no
  job.
*/

// ioredis de mentira, com o subconjunto que o spool usa. Guardar isto em memoria
// e' suficiente porque o que se testa aqui e' o protocolo (quantas copias,
// quando apaga), nao o Redis.
function createFakeRedis() {
  const hashes = new Map();
  const expirations = new Map();
  const stats = { hset: 0, hgetall: 0, del: 0 };

  function ensure(key) {
    if (!hashes.has(key)) {
      hashes.set(key, new Map());
    }

    return hashes.get(key);
  }

  const redis = {
    async hset(key, values) {
      stats.hset += 1;

      const hash = ensure(key);

      for (const [field, value] of Object.entries(values)) {
        hash.set(field, String(value));
      }

      return Object.keys(values).length;
    },
    async hincrby(key, field, delta) {
      const hash = ensure(key);
      const next = Number(hash.get(field) || 0) + delta;

      hash.set(field, String(next));

      return next;
    },
    async pexpire(key, ttlMs) {
      expirations.set(key, ttlMs);

      return 1;
    },
    async hgetall(key) {
      stats.hgetall += 1;

      const hash = hashes.get(key);

      if (!hash) {
        return {};
      }

      return Object.fromEntries(hash);
    },
    async del(key) {
      stats.del += 1;
      expirations.delete(key);

      return hashes.delete(key) ? 1 : 0;
    },
    multi() {
      const queued = [];
      const chain = {
        hset: (...args) => (queued.push(() => redis.hset(...args)), chain),
        hincrby: (...args) => (queued.push(() => redis.hincrby(...args)), chain),
        pexpire: (...args) => (queued.push(() => redis.pexpire(...args)), chain),
        async exec() {
          const results = [];

          for (const step of queued) {
            results.push([null, await step()]);
          }

          return results;
        },
      };

      return chain;
    },
  };

  return { redis, hashes, expirations, stats };
}

const VIDEO_BASE64 = Buffer.from("conteudo-de-video-que-seria-enorme-em-producao").toString("base64");
const CONTENT = { base64: VIDEO_BASE64, mimeType: "video/mp4", fileName: "aula.mp4", type: "video" };

/*
  1. O TESTE QUE JUSTIFICA A MUDANCA.

  Um disparo agendado para varios grupos: o anexo tem de ser depositado UMA vez e
  nenhum job pode carregar o base64. Antes, cada job levava uma copia integral.
*/
async function testBase64NaoEntraNoJob() {
  const { redis, stats } = createFakeRedis();
  const enfileirados = [];
  const gruposDoLote = 12;

  const service = createMensagensService({
    groupsRepository: {
      async findById(id) {
        return { id, nome: `Grupo ${id}`, evolution_group_id: `${id}@g.us`, segmento: "aviso", organization_id: "org-1" };
      },
    },
    campaignsRepository: {
      async create(payload) { return { id: "campaign-1", ...payload }; },
      async update(id, payload) { return { id, ...payload }; },
      async listActiveOverlappingWindow() { return []; },
    },
    campaignGroupsRepository: { async associateGroup() { return {}; }, async listGroups() { return []; } },
    dispatchLogsRepository: {
      async createLog(payload) { return { id: `log-${payload.group_id}`, ...payload }; },
      async updateStatus() { return {}; },
      async updateProviderDelivery() { return {}; },
      async updatePlannedSchedule() { return {}; },
      async updateDispatchJobId() { return {}; },
    },
    whatsappInstancesRepository: { async listActive() { return [{ id: "instance-1", priority: 0 }]; } },
    whatsappInstancesService: {
      async listDispatchableInstances() { return [{ id: "instance-1", priority: 0 }]; },
      async filterDispatchableGroups(ids) { return { eligible: ids, ineligible: [] }; },
      async getRotationSettings() { return { whatsapp_rotation_group_count: 1 }; },
    },
    settingsService: { async getSettings() { return { timezone: "America/Sao_Paulo" }; }, async getScheduleSettings() { return {}; } },
    // O preparo (ffmpeg) nao e' o assunto aqui: devolve o conteudo intacto.
    prepareAdHocMediaContent: async (content) => content,
    putMediaInSpool: (content, options) => putMediaInSpool(content, { ...options, redis }),
    addMensagensDispatchJob: async (params) => {
      enfileirados.push(params);
      return { id: `job-${enfileirados.length}` };
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  const groupIds = Array.from({ length: gruposDoLote }, (_, index) => `group-${index}`);

  const resposta = await service.dispatchAdHocAsync({
    group_ids: groupIds,
    texto: "aula nova",
    content: CONTENT,
  });

  // Video com base64 sai do ciclo da requisicao de proposito (o ffmpeg pode
  // levar minutos e estouraria o timeout do proxy), entao a resposta vem antes
  // do enfileiramento - a tela acompanha por getDispatchStatus.
  assert.equal(resposta.preparando_midia, true);

  for (let tentativa = 0; tentativa < 100 && enfileirados.length < gruposDoLote; tentativa += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(enfileirados.length, gruposDoLote, "todos os grupos precisam ser enfileirados");

  // O ponto central: nenhuma copia do base64 nos jobs.
  for (const params of enfileirados) {
    const jobData = buildMensagensJobData(params);

    assert.equal(jobData.content, null, "o job nao pode carregar o anexo inline");
    assert.ok(jobData.content_ref, "o job precisa carregar a referencia do anexo");
    assert.equal(
      JSON.stringify(jobData).includes(VIDEO_BASE64),
      false,
      "o base64 do anexo nao pode aparecer em lugar nenhum do job data - era isso que o " +
        "replicava por grupo e era reescrito a cada job.updateData"
    );
    // Metadados viajam na referencia: sao poucos bytes e permitem montar
    // mensagem de erro legivel quando a entrada expira.
    assert.equal(jobData.content_ref.file_name, "aula.mp4");
    assert.equal(jobData.content_ref.mime_type, "video/mp4");
  }

  // Uma unica escrita do anexo, para os 12 grupos.
  assert.equal(stats.hset, 1, `esperava 1 deposito do anexo, houve ${stats.hset}`);
  // E todos apontam para a MESMA entrada.
  assert.equal(new Set(enfileirados.map((params) => params.content_ref.spool_key)).size, 1);
}

// 2. CHAVE PELO CONTEUDO. Dois disparos do mesmo arquivo compartilham a entrada,
//    e arquivos diferentes nao colidem.
async function testChaveEhOConteudo() {
  const { redis, stats } = createFakeRedis();

  const primeiro = await putMediaInSpool(CONTENT, { consumers: 2, redis });
  const segundo = await putMediaInSpool({ ...CONTENT, fileName: "outro-nome.mp4" }, { consumers: 3, redis });

  assert.equal(primeiro.spool_key, segundo.spool_key, "o mesmo conteudo tem de cair na mesma entrada");
  assert.equal(stats.hset, 2, "o hset e' idempotente sobre a mesma chave; o que soma e' o contador");

  const outro = await putMediaInSpool({ ...CONTENT, base64: Buffer.from("outro video").toString("base64") }, { redis });
  assert.notEqual(outro.spool_key, primeiro.spool_key);

  assert.equal(digestContent(CONTENT), digestContent({ base64: CONTENT.base64 }));
}

// 3. LIBERACAO SO APAGA NO ULTIMO. Com o contador errado, o primeiro grupo do
//    lote apagaria o anexo dos outros onze.
async function testApagaSoNoUltimoConsumidor() {
  const { redis, hashes, expirations, stats } = createFakeRedis();

  const reference = await putMediaInSpool(CONTENT, { consumers: 3, redis });
  const key = `${SPOOL_KEY_PREFIX}${reference.spool_key}`;

  assert.equal(expirations.get(key), DEFAULT_SPOOL_TTL_MS, "o TTL e' a rede de seguranca: tem de existir sempre");

  let result = await releaseMediaFromSpool(reference, { redis });
  assert.deepEqual(result, { released: true, deleted: false, pending: 2 });
  assert.ok(hashes.has(key), "ainda ha grupos por enviar; o anexo nao pode ter sido apagado");

  result = await releaseMediaFromSpool(reference, { redis });
  assert.equal(result.pending, 1);
  assert.ok(hashes.has(key));

  result = await releaseMediaFromSpool(reference, { redis });
  assert.equal(result.deleted, true);
  assert.equal(hashes.has(key), false, "no ultimo consumidor o anexo sai do Redis, sem esperar o TTL");
  assert.equal(stats.del, 1);

  // Liberar de novo (job duplicado, retry manual) nao pode explodir.
  await releaseMediaFromSpool(reference, { redis });
  await releaseMediaFromSpool(null, { redis });
}

// 4. IDA E VOLTA. O que sai do spool tem de ser byte a byte o que entrou, no
//    formato que sendToEvolution espera ({ base64, mimeType, fileName, type }).
async function testLeituraDevolveOMesmoConteudo() {
  const { redis } = createFakeRedis();
  const reference = await putMediaInSpool(CONTENT, { consumers: 1, redis });
  const recuperado = await readMediaFromSpool(reference, { redis });

  assert.deepEqual(recuperado, {
    base64: VIDEO_BASE64,
    mimeType: "video/mp4",
    fileName: "aula.mp4",
    type: "video",
  });

  // Aceita tambem a chave nua, e devolve null para entrada inexistente.
  assert.deepEqual(await readMediaFromSpool(reference.spool_key, { redis }), recuperado);
  assert.equal(await readMediaFromSpool("chave-que-nao-existe", { redis }), null);
  assert.equal(await readMediaFromSpool(null, { redis }), null);
}

// 5. O WORKER HIDRATA E LIBERA. E' aqui que o anexo volta a existir - no ultimo
//    instante antes do envio, e nao durante a espera na fila.
async function testWorkerEnviaComAnexoDoSpoolELibera() {
  const { redis, hashes } = createFakeRedis();
  const reference = await putMediaInSpool(CONTENT, { consumers: 1, redis });
  const enviados = [];

  const processor = createMensagensDispatchProcessor({
    logger: { info() {}, warn() {}, error() {} },
    dispatchLogs: { async updateStatus() { return {}; }, async updateProviderDelivery() { return {}; } },
    sender: async (params) => {
      enviados.push(params);
      return { status: 201, data: { key: { id: "3EB0" }, status: "PENDING" } };
    },
    confirmDelivery: async () => ({ confirmed: true }),
    readSpooledMedia: (ref) => readMediaFromSpool(ref, { redis }),
    releaseSpooledMedia: (ref) => releaseMediaFromSpool(ref, { redis }),
  });

  const jobData = buildMensagensJobData({
    group_id: "120363000000000000@g.us",
    internal_group_id: "group-1",
    message: "aula nova",
    content_ref: reference,
    scheduled_at: new Date().toISOString(),
  });

  const result = await processor({
    id: "job-1",
    data: jobData,
    async updateData() {},
  });

  assert.equal(result.status, "sent");
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].content.base64, VIDEO_BASE64, "o anexo enviado tem de ser o que foi depositado");
  assert.equal(enviados[0].content.fileName, "aula.mp4");
  assert.equal(
    hashes.has(`${SPOOL_KEY_PREFIX}${reference.spool_key}`),
    false,
    "depois do envio o anexo tem de sair do Redis"
  );
}

/*
  6. ANEXO SUMIDO FALHA O ENVIO - nao manda so o texto.

  Se a entrada expirou (job muito atrasado, Redis limpo), enviar a mensagem sem o
  anexo entregaria ao grupo algo diferente do que foi agendado, e ninguem
  saberia. Aqui o envio falha com motivo registrado, que e' o unico desfecho
  honesto.
*/
async function testAnexoAusenteFalhaOEnvio() {
  const { redis } = createFakeRedis();
  const enviados = [];
  const statusGravados = [];

  const processor = createMensagensDispatchProcessor({
    logger: { info() {}, warn() {}, error() {} },
    dispatchLogs: {
      async updateStatus(id, status, mensagem) {
        statusGravados.push({ status, mensagem });
        return {};
      },
      async updateProviderDelivery() { return {}; },
    },
    sender: async (params) => {
      enviados.push(params);
      return { status: 201, data: { key: { id: "3EB0" }, status: "PENDING" } };
    },
    confirmDelivery: async () => ({ confirmed: true }),
    readSpooledMedia: (ref) => readMediaFromSpool(ref, { redis }),
    releaseSpooledMedia: (ref) => releaseMediaFromSpool(ref, { redis }),
  });

  const jobData = buildMensagensJobData({
    group_id: "120363000000000000@g.us",
    internal_group_id: "group-1",
    message: "aula nova",
    content_ref: { spool_key: "expirou", file_name: "aula.mp4", mime_type: "video/mp4", type: "video" },
    dispatch_log_id: "log-1",
    scheduled_at: new Date().toISOString(),
  });

  await assert.rejects(
    () => processor({ id: "job-1", data: jobData, async updateData() {} }),
    /nao esta mais disponivel/
  );

  assert.equal(enviados.length, 0, "sem o anexo, nada pode ser enviado - nem o texto sozinho");
  assert.equal(statusGravados.at(-1).status, "falhou");
  assert.match(statusGravados.at(-1).mensagem, /aula\.mp4/, "o motivo tem de nomear o arquivo perdido");
}

/*
  7. COMPATIBILIDADE COM JOB ANTIGO.

  No deploy, a fila pode ter jobs agendados ANTES da mudanca, com o base64 ainda
  dentro de `content`. Eles precisam sair normalmente - do contrario a
  introducao do spool cancelaria envios ja agendados.
*/
async function testJobAntigoComBase64InlineAindaEnvia() {
  const enviados = [];

  const processor = createMensagensDispatchProcessor({
    logger: { info() {}, warn() {}, error() {} },
    dispatchLogs: { async updateStatus() { return {}; }, async updateProviderDelivery() { return {}; } },
    sender: async (params) => {
      enviados.push(params);
      return { status: 201, data: { key: { id: "3EB0" }, status: "PENDING" } };
    },
    confirmDelivery: async () => ({ confirmed: true }),
    readSpooledMedia: async () => {
      throw new Error("job antigo nao deve consultar o spool");
    },
    releaseSpooledMedia: async () => {
      throw new Error("job antigo nao tem referencia para liberar");
    },
  });

  const jobData = buildMensagensJobData({
    group_id: "120363000000000000@g.us",
    internal_group_id: "group-1",
    message: "aula nova",
    content: CONTENT,
    scheduled_at: new Date().toISOString(),
  });

  const result = await processor({ id: "job-antigo", data: jobData, async updateData() {} });

  assert.equal(result.status, "sent");
  assert.equal(enviados[0].content.base64, VIDEO_BASE64);
}

// 8. TTL configuravel, com saneamento - valor invalido nao pode virar "sem TTL",
//    que deixaria o anexo no Redis para sempre se ninguem liberasse.
function testTtlConfiguravel() {
  delete process.env.MEDIA_SPOOL_TTL_MS;
  assert.equal(resolveSpoolTtlMs(), DEFAULT_SPOOL_TTL_MS);

  process.env.MEDIA_SPOOL_TTL_MS = "60000";
  assert.equal(resolveSpoolTtlMs(), 60000);

  for (const invalido of ["0", "-1", "abc", ""]) {
    process.env.MEDIA_SPOOL_TTL_MS = invalido;
    assert.equal(resolveSpoolTtlMs(), DEFAULT_SPOOL_TTL_MS, `valor "${invalido}" deveria cair no padrao`);
  }

  delete process.env.MEDIA_SPOOL_TTL_MS;
}

async function main() {
  await testBase64NaoEntraNoJob();
  await testChaveEhOConteudo();
  await testApagaSoNoUltimoConsumidor();
  await testLeituraDevolveOMesmoConteudo();
  await testWorkerEnviaComAnexoDoSpoolELibera();
  await testAnexoAusenteFalhaOEnvio();
  await testJobAntigoComBase64InlineAindaEnvia();
  testTtlConfiguravel();

  console.log("media-spool tests OK");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    closeQueueInfrastructure();
  });
