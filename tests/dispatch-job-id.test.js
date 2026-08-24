/*
  Regressao: nenhuma fila definia `jobId`, entao a BullMQ atribuia um contador
  auto-incremental e o Redis nao deduplicava nada. No ramo SEM
  dispatch-consistency (campanha legada por link_video, ou retry sem video_id
  resolvivel) nao existe log de tentativa, nem claimForSend, e
  registerDispatchProgress retorna null cedo por falta de video_id - nem o
  UNIQUE (group_id, video_id) de group_video_progress se aplica. Uma reentrega
  por job travado postava o video DUAS VEZES no grupo.

  O jobId deterministico fecha isso. Estes testes fixam as duas propriedades
  opostas que a chave precisa ter ao mesmo tempo.

  Segunda regressao, encontrada em producao apos a primeira correcao: o join
  original usava ":" como separador entre os 6 componentes, e scheduled_at
  (data ISO) sempre contem ":". A BullMQ so aceita ":" num jobId customizado
  se o resultado tiver EXATAMENTE 3 segmentos (reservado ao formato interno de
  repeatable jobs); com 6+ segmentos ela lanca "Custom Id cannot contain :" -
  o que derrubava a criacao de TODO job de dispatch, sem excecao, direto no
  worker de campaign-trigger, antes mesmo do primeiro grupo ser enfileirado.
  `assertValidBullmqJobId` abaixo reproduz a validacao exata de
  bullmq/dist/cjs/classes/job.js (Job.validateOptions) para todo jobId gerado
  nestes testes, para essa classe de bug nunca mais passar despercebida.
*/
const assert = require("node:assert/strict");

const { buildDispatchJobData, buildDispatchJobId } = require("../src/queues/dispatch");

function assertValidBullmqJobId(jobId) {
  assert.notEqual(`${parseInt(jobId, 10)}`, jobId, `jobId nao pode ser um inteiro puro: ${jobId}`);

  if (jobId.includes(":")) {
    assert.equal(
      jobId.split(":").length,
      3,
      `jobId com ":" so e aceito pela BullMQ com exatamente 3 segmentos (formato de repeatable job): ${jobId}`
    );
  }
}

const CAMPAIGN = "11111111-1111-1111-8111-111111111111";
const GROUP_UUID = "22222222-2222-1222-8222-222222222222";
const VIDEO_UUID = "33333333-3333-1333-8333-333333333333";

function jobFor(overrides = {}) {
  return buildDispatchJobData({
    campaign_id: CAMPAIGN,
    group_id: "120363000000000000@g.us",
    progress_group_id: GROUP_UUID,
    video_id: VIDEO_UUID,
    scheduled_at: "2026-08-23T10:00:00.000Z",
    ...overrides,
  });
}

// O caso que causava duplicata: mesmo trio, mesmo horario, enfileirado de novo.
async function testMesmoEnvioProduzMesmoJobId() {
  assert.equal(
    buildDispatchJobId(jobFor()),
    buildDispatchJobId(jobFor()),
    "o mesmo envio precisa colidir para a BullMQ recusar a duplicata"
  );
}

// Cobre especificamente o ramo desprotegido: sem video_id, a chave cai no
// drive_file_id e depois no link_video - e ainda assim deduplica.
async function testRamoSemVideoIdTambemDeduplica() {
  const semVideoId = { video_id: undefined, link_video: "https://exemplo/v.mp4" };
  const id = buildDispatchJobId(jobFor(semVideoId));

  assertValidBullmqJobId(id);
  assert.equal(id, buildDispatchJobId(jobFor(semVideoId)));
  // O "://" da URL nao pode sobreviver cru na chave (ver assertValidBullmqJobId
  // acima) - mas o dominio/caminho continuam identificaveis, o que basta para
  // depurar via `queues:inspect` sem expor a URL inteira sem sanitizar.
  assert.match(id, /exemplo.v\.mp4/);

  // drive_file_id tem precedencia sobre link_video quando ambos existem.
  const comDrive = { video_id: undefined, drive_file_id: "drive-abc", link_video: "https://exemplo/v.mp4" };
  assert.match(buildDispatchJobId(jobFor(comDrive)), /drive-abc/);
}

// Envios legitimamente distintos NAO podem colidir, senao a deduplicacao
// engoliria disparos validos.
async function testEnviosDistintosProduzemJobIdsDistintos() {
  const base = buildDispatchJobId(jobFor());

  const variacoes = {
    "outro horario (reagendamento/recorrente)": jobFor({ scheduled_at: "2026-08-23T11:00:00.000Z" }),
    "outro grupo": jobFor({ progress_group_id: "44444444-4444-1444-8444-444444444444" }),
    "outro video": jobFor({ video_id: "55555555-5555-1555-8555-555555555555" }),
    "outra campanha": jobFor({ campaign_id: "66666666-6666-1666-8666-666666666666" }),
  };

  for (const [descricao, jobData] of Object.entries(variacoes)) {
    assert.notEqual(buildDispatchJobId(jobData), base, `${descricao} deve gerar jobId proprio`);
  }
}

// A armadilha: o sweep de retry (dispatch-failure-retry.js) reenfileira
// PRESERVANDO o scheduled_at original, para a trava de atraso continuar
// ancorada no horario real. Sem retry_count na chave, todo retry colidiria com
// o envio que falhou e seria descartado em silencio pela BullMQ - o
// reprocessamento inteiro pararia de funcionar.
async function testRetryNaoColideComOEnvioOriginal() {
  const original = buildDispatchJobId(jobFor({ retry_count: 0 }));
  const primeiroRetry = buildDispatchJobId(jobFor({ retry_count: 1 }));
  const segundoRetry = buildDispatchJobId(jobFor({ retry_count: 2 }));

  assert.notEqual(primeiroRetry, original, "retry preserva scheduled_at, entao precisa de retry_count na chave");
  assert.notEqual(segundoRetry, primeiroRetry);

  // Ausencia de retry_count e' equivalente a zero (o envio original).
  assert.equal(buildDispatchJobId(jobFor()), original);
}

// Sweep independente: gera jobId para uma matriz de cenarios realistas
// (scheduled_at sempre tem ":", link_video sempre tem "://", campaign_id as
// vezes vem de sistema legado com caracteres nao-UUID) e valida CADA UM contra
// a regra real da BullMQ. E' o teste que teria pego a regressao de producao
// antes do deploy: nenhum dos testes anteriores validava o jobId contra a
// biblioteca, so contra as proprias expectativas do teste.
async function testTodosOsJobIdsGeradosSaoValidosParaABullmq() {
  const cenarios = [
    jobFor(),
    jobFor({ video_id: undefined, link_video: "https://drive.google.com/file/d/abc123/view" }),
    jobFor({ video_id: undefined, drive_file_id: "1a2b:3c4d" }),
    jobFor({ retry_count: 5 }),
    jobFor({ campaign_id: "manual-test" }),
    jobFor({ scheduled_at: "2026-12-31T23:59:59.999Z" }),
  ];

  for (const jobData of cenarios) {
    assertValidBullmqJobId(buildDispatchJobId(jobData));
  }
}

async function main() {
  await testMesmoEnvioProduzMesmoJobId();
  await testRamoSemVideoIdTambemDeduplica();
  await testEnviosDistintosProduzemJobIdsDistintos();
  await testRetryNaoColideComOEnvioOriginal();
  await testTodosOsJobIdsGeradosSaoValidosParaABullmq();
  console.log("dispatch job id tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
