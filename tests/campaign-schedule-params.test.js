/*
  Cobertura do modulo extraido de campaign-trigger.js na refatoracao.

  Estas funcoes sao puras (nao tocam Redis, banco nem rede) e antes so eram
  exercitadas indiretamente, atraves do processor - que exige stub de metade da
  infraestrutura. Testa-las direto fixa o contrato de validacao dos parametros
  de agendamento, que e' por onde entram os dados vindos da API e dos scripts.
*/
const assert = require("node:assert/strict");

const {
  CAMPAIGN_TRIGGER_TYPE_RECURRING,
  assertCampaignId,
  buildCampaignScheduleKey,
  buildCampaignTriggerJobData,
  formatScheduledDateTime,
  getCampaignTimezone,
  normalizeBooleanStatus,
  normalizeDateField,
  normalizeTimeWindow,
} = require("../src/queues/campaign-schedule-params");

async function testJanelaExigeInicioEFimJuntos() {
  assert.equal(normalizeTimeWindow({}), undefined, "sem janela e' valido (campanha sem restricao)");

  assert.deepEqual(
    normalizeTimeWindow({ window_start: "07:00", window_end: "10:00", timezone: "America/Bahia" }),
    { start: "07:00", end: "10:00", timezone: "America/Bahia" }
  );

  // Meia janela e' erro de configuracao, nao "sem janela" - senao a campanha
  // dispararia sem o limite que o operador achou que tinha configurado.
  assert.throws(() => normalizeTimeWindow({ window_start: "07:00" }), /juntos/);
  assert.throws(() => normalizeTimeWindow({ window_end: "10:00" }), /juntos/);

  // Aceita as formas camelCase e o objeto aninhado.
  assert.deepEqual(normalizeTimeWindow({ timeWindow: { start: "08:00", end: "09:00" } }).start, "08:00");
  assert.deepEqual(normalizeTimeWindow({ windowStart: "08:00", windowEnd: "09:00" }).end, "09:00");
}

async function testStatusAtivoPorPadraoEDesativaNasVariantes() {
  assert.equal(normalizeBooleanStatus({}), true, "sem status informado, a campanha nasce ativa");
  assert.equal(normalizeBooleanStatus({ active: true }), true);
  assert.equal(normalizeBooleanStatus({ active: false }), false);

  // Aceita as grafias que a API/scripts realmente mandam, em pt e en.
  for (const valor of ["false", "0", "inactive", "inativo", "disabled", "paused"]) {
    assert.equal(normalizeBooleanStatus({ active: valor }), false, `active="${valor}" deve desativar`);
  }
  for (const status of ["inactive", "inativo", "inativa", "disabled", "paused", "cancelled", "canceled"]) {
    assert.equal(normalizeBooleanStatus({ status }), false, `status="${status}" deve desativar`);
  }

  assert.equal(normalizeBooleanStatus({ status: "active" }), true);
  assert.equal(normalizeBooleanStatus({ status: "programado" }), true, "status desconhecido nao desativa");
}

async function testCampaignIdEObrigatorio() {
  assert.throws(() => assertCampaignId({}), /campaign_id/i);
  assert.doesNotThrow(() => assertCampaignId({ campaign_id: "abc" }));
}

async function testChaveDeAgendamentoEscapaOId() {
  assert.equal(buildCampaignScheduleKey("abc-123"), "campaign-trigger-abc-123");
  // Escapar importa: a chave vira parte do identificador do repeatable na
  // BullMQ, e um id com caractere especial corromperia a chave.
  assert.equal(buildCampaignScheduleKey("a/b c"), "campaign-trigger-a%2Fb%20c");
}

async function testDataInvalidaEhRejeitadaComNomeDoCampo() {
  assert.equal(normalizeDateField(undefined, "execution_at"), undefined);
  assert.throws(() => normalizeDateField("nao-e-data", "execution_at"), /execution_at/);
  // Devolve um Date, nao a string original.
  const parsed = normalizeDateField("2026-08-23T10:00:00.000Z", "execution_at");
  assert.ok(parsed instanceof Date);
  assert.equal(parsed.toISOString(), "2026-08-23T10:00:00.000Z");

  // Um Date ja valido passa direto.
  const asDate = new Date("2026-08-23T10:00:00.000Z");
  assert.equal(normalizeDateField(asDate, "execution_at").getTime(), asDate.getTime());
}

// A formatacao usa o fuso da campanha, nao o do processo - mesma garantia
// coberta em dispatch-jitter-timezone.test.js, aqui na origem.
async function testFormatacaoUsaFusoDaCampanha() {
  const { data_envio, horario_envio } = formatScheduledDateTime(
    "2026-08-23T10:00:00.000Z",
    "America/Bahia"
  );

  assert.equal(data_envio, "2026-08-23");
  assert.equal(horario_envio, "07:00:00", "10:00 UTC e' 07:00 em America/Bahia (UTC-3)");
}

async function testFusoPadraoTemCadeiaDeFallback() {
  const original = process.env.CAMPAIGN_TIMEZONE;
  const originalTz = process.env.TZ;

  try {
    process.env.CAMPAIGN_TIMEZONE = "America/Sao_Paulo";
    assert.equal(getCampaignTimezone(), "America/Sao_Paulo");

    delete process.env.CAMPAIGN_TIMEZONE;
    process.env.TZ = "UTC";
    assert.equal(getCampaignTimezone(), "UTC", "sem CAMPAIGN_TIMEZONE, cai em TZ");

    delete process.env.TZ;
    assert.equal(getCampaignTimezone(), "America/Bahia", "sem nenhuma, cai no default");
  } finally {
    if (original === undefined) delete process.env.CAMPAIGN_TIMEZONE;
    else process.env.CAMPAIGN_TIMEZONE = original;
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
}

async function testJobDataCarregaOsCamposEssenciais() {
  const jobData = buildCampaignTriggerJobData({
    campaign_id: "campanha-1",
    execution_at: "2026-08-23T10:00:00.000Z",
  });

  assert.equal(jobData.campaign_id, "campanha-1");
  assert.equal(jobData.execution_at, "2026-08-23T10:00:00.000Z");
  assert.notEqual(jobData.trigger_type, CAMPAIGN_TRIGGER_TYPE_RECURRING, "job pontual nao e' recorrente");
}

async function main() {
  await testJanelaExigeInicioEFimJuntos();
  await testStatusAtivoPorPadraoEDesativaNasVariantes();
  await testCampaignIdEObrigatorio();
  await testChaveDeAgendamentoEscapaOId();
  await testDataInvalidaEhRejeitadaComNomeDoCampo();
  await testFormatacaoUsaFusoDaCampanha();
  await testFusoPadraoTemCadeiaDeFallback();
  await testJobDataCarregaOsCamposEssenciais();
  console.log("campaign schedule params tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
