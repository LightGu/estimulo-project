const assert = require("node:assert/strict");

const { buildDispatchRef, buildMensagensRef, shortId } = require("../src/utils/dispatch-ref");
const { buildDispatchJobData } = require("../src/queues/dispatch");
const { buildMensagensJobData } = require("../src/queues/mensagens-dispatch");
const { closeQueueInfrastructure } = require("../src/queues/bullmq");

/*
  O ref de correlacao existe porque nao havia UMA chave que atravessasse o
  caminho de envio. Cada camada identificava o envio de um jeito diferente, com
  o detalhe cruel de que `group_id` significa o JID da Evolution no job e a PK
  do Postgres no log - invertido em relacao a `progress_group_id`. Os dois
  identificadores mais uteis (log_id e provider_message_id) so passam a existir
  no meio do caminho.

  As propriedades abaixo sao o que torna o ref util; se qualquer uma quebrar, ele
  volta a ser decoracao.
*/

const CAMPAIGN = "11111111-1111-4111-8111-111111111111";
const GROUP_DB = "22222222-2222-4222-8222-222222222222";
const VIDEO = "33333333-3333-4333-8333-333333333333";
const GROUP_JID = "120363000000000000@g.us";
const SCHEDULED = "2026-09-07T14:00:00.000Z";

// 1. DETERMINISTICO. E' a propriedade central: o log pendente e' criado pela API
//    (na confirmacao) e o job pelo worker (no trigger), em processos diferentes
//    que nao se falam. Os dois precisam chegar ao mesmo valor, senao a coluna do
//    banco e os logs dos workers apontam para refs distintos e a correlacao
//    morre exatamente onde deveria servir.
function testRefEhDeterministico() {
  const a = buildDispatchRef({ campaignId: CAMPAIGN, groupId: GROUP_DB, videoId: VIDEO, scheduledAt: SCHEDULED });
  const b = buildDispatchRef({ campaignId: CAMPAIGN, groupId: GROUP_DB, videoId: VIDEO, scheduledAt: SCHEDULED });

  assert.equal(a, b);
  // Aceita snake_case tambem, porque as duas convencoes convivem no projeto.
  const c = buildDispatchRef({ campaign_id: CAMPAIGN, group_id: GROUP_DB, video_id: VIDEO, scheduled_at: SCHEDULED });
  assert.equal(a, c, "as duas convencoes de nome precisam produzir o mesmo ref");
}

// 2. ESTAVEL ENTRE TENTATIVAS E REAGENDAMENTOS. Diferente do jobId, que PRECISA
//    mudar a cada retry e a cada horario (senao a BullMQ descarta o job em
//    silencio), o ref identifica o ENVIO. markRetrying reaproveita a MESMA linha
//    em `logs`, e resumeCampaign/ensurePendingDispatchLogs deslocam o horario
//    planejado dessa mesma linha - se tentativa ou horario compusessem a chave,
//    a coluna do banco e os eventos do worker apontariam para refs diferentes
//    para o mesmo envio, e o grep que justifica o ref existir nao acharia as
//    duas pontas.
function testRefEstavelEntreTentativas() {
  const base = {
    group_id: GROUP_JID,
    campaign_id: CAMPAIGN,
    progress_group_id: GROUP_DB,
    video_id: VIDEO,
    scheduled_at: SCHEDULED,
  };

  const original = buildDispatchJobData(base);
  const retry = buildDispatchJobData({ ...base, retry_count: 3 });
  // Reagendamento: mesma linha de log, horario novo (o caso do resume).
  const reagendado = buildDispatchJobData({ ...base, scheduled_at: "2026-09-09T20:30:00.000Z" });

  assert.equal(original.dispatch_ref, retry.dispatch_ref);
  assert.equal(
    original.dispatch_ref,
    reagendado.dispatch_ref,
    "reagendar o envio nao pode trocar o ref: o log e' o mesmo"
  );
  assert.equal(retry.retry_count, 3, "a tentativa continua registrada, separada do ref");
  assert.notEqual(
    original.scheduled_at,
    reagendado.scheduled_at,
    "o horario muda de verdade; e' o ref que precisa ignora-lo"
  );
}

// 3. USA A PK DO GRUPO, NAO O JID. O ref tem de casar com o `group_id` da tabela
//    `logs` (que e a PK), nao com o JID que o job carrega em group_id - essa
//    inversao de significado entre camadas e' justamente o que tornava a
//    correlacao manual tao propensa a erro.
function testRefUsaChaveDoBancoENaoOJid() {
  const jobData = buildDispatchJobData({
    group_id: GROUP_JID,
    campaign_id: CAMPAIGN,
    progress_group_id: GROUP_DB,
    video_id: VIDEO,
    scheduled_at: SCHEDULED,
  });

  const esperado = buildDispatchRef({
    campaignId: CAMPAIGN,
    groupId: GROUP_DB,
    videoId: VIDEO,
  });

  assert.equal(jobData.dispatch_ref, esperado);
  assert.ok(
    jobData.dispatch_ref.includes(shortId(GROUP_DB)),
    "o ref precisa conter a PK do grupo, que e' o que `logs.group_id` guarda"
  );
  assert.ok(
    !jobData.dispatch_ref.includes("120363"),
    "o JID da Evolution nao deve entrar no ref: ele nao e' a chave do relatorio"
  );
}

// 4. DISTINGUE ENVIOS DIFERENTES. Trocar qualquer componente muda o ref - sem
//    isso dois envios distintos apareceriam sob a mesma chave no log.
function testRefDistingueEnviosDiferentes() {
  const base = { campaignId: CAMPAIGN, groupId: GROUP_DB, videoId: VIDEO, scheduledAt: SCHEDULED };
  const ref = buildDispatchRef(base);

  // Somente os componentes do trio distinguem envios; o horario NAO (ver acima).
  const variacoes = [
    { ...base, campaignId: "99999999-9999-4999-8999-999999999999" },
    { ...base, groupId: "88888888-8888-4888-8888-888888888888" },
    { ...base, videoId: "77777777-7777-4777-8777-777777777777" },
  ];

  for (const variacao of variacoes) {
    assert.notEqual(buildDispatchRef(variacao), ref);
  }
}

// 5. SEM ":" DEMAIS NO CAMINHO DA BULLMQ. O ref viaja no job data (nao no jobId),
//    entao nao sofre a regra dos 3 segmentos - mas ele e' colado em mensagens de
//    log e em tags do Sentry, e um formato estavel importa. Aqui so se fixa o
//    formato, para que uma mudanca acidental apareca.
function testFormatoDoRef() {
  const ref = buildDispatchRef({ campaignId: CAMPAIGN, groupId: GROUP_DB, videoId: VIDEO, scheduledAt: SCHEDULED });

  assert.match(ref, /^d:[0-9a-f]{1,8}:[0-9a-f]{1,8}:[0-9a-f]{1,8}$/, `formato inesperado: ${ref}`);
  assert.ok(ref.length <= 48, "o ref precisa caber numa linha de log e num grep");
}

// 6. O CAMINHO PONTUAL TEM PREFIXO PROPRIO. "de qual fila veio esse envio?" e a
//    primeira pergunta ao abrir um log, e o prefixo a responde sem consulta.
function testRefDeMensagemPontual() {
  const comLog = buildMensagensRef({ dispatchLogId: "abcd1234-0000-4000-8000-000000000000" });
  assert.match(comLog, /^m:log:[0-9a-f]{1,8}$/);

  const semLog = buildMensagensRef({ internalGroupId: GROUP_DB, scheduledAt: SCHEDULED });
  assert.match(semLog, /^m:[0-9a-f]{1,8}:\d+$/);

  // E o job real carrega o ref.
  const jobData = buildMensagensJobData({
    group_id: GROUP_JID,
    internal_group_id: GROUP_DB,
    message: "oi",
    dispatch_log_id: "abcd1234-0000-4000-8000-000000000000",
    scheduled_at: SCHEDULED,
  });
  assert.equal(jobData.dispatch_ref, comLog);
  assert.ok(jobData.dispatch_ref.startsWith("m:"), "envio pontual precisa ser distinguivel do de video pelo prefixo");
}

// 7. NAO EXPLODE COM ENTRADA FALTANTE. O ramo legado (campaign_id "manual-test",
//    envio sem video_id) tem de continuar produzindo um ref utilizavel em vez de
//    derrubar o enfileiramento.
function testRefToleraEntradaIncompleta() {
  assert.doesNotThrow(() => buildDispatchRef({}));
  assert.doesNotThrow(() => buildMensagensRef({}));

  const legado = buildDispatchJobData({
    group_id: GROUP_JID,
    campaign_id: "manual-test",
    link_video: "https://drive.google.com/file/d/abc/view",
    scheduled_at: SCHEDULED,
  });

  assert.ok(legado.dispatch_ref, "o ramo legado tambem precisa de ref");
  assert.ok(legado.dispatch_ref.startsWith("d:"));
}

function main() {
  testRefEhDeterministico();
  testRefEstavelEntreTentativas();
  testRefUsaChaveDoBancoENaoOJid();
  testRefDistingueEnviosDiferentes();
  testFormatoDoRef();
  testRefDeMensagemPontual();
  testRefToleraEntradaIncompleta();

  console.log("dispatch-ref tests OK");
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  closeQueueInfrastructure();
}
