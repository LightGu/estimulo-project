/*
  Regressao: normalizeTimePoint/normalizeDispatchWindow (src/queues/dispatch-jitter.js)
  convertiam um horario "HH:mm" de janela em instante via `Date#setHours`, que
  resolve no fuso do PROCESSO Node, nao no fuso da campanha (CAMPAIGN_TIMEZONE).
  Funcionava por coincidencia porque TZ e CAMPAIGN_TIMEZONE concordam no ambiente
  configurado (America/Bahia nos dois); um container sem tzdata, ou so uma das
  duas variaveis mudando, deslocava todo horario sorteado sem erro nem log.

  Estes testes fixam o comportamento correto simulando exatamente esse
  descompasso: passam timezone diferente do fuso do processo (que nos testes e'
  o fuso do CI/da maquina do desenvolvedor, imprevisivel) via o parametro
  `timezone` que dispatch-jitter.js agora aceita.
*/
const assert = require("node:assert/strict");

const { buildJitteredDispatchSchedule, normalizeDispatchWindow } = require("../src/queues/dispatch-jitter");

function createBaseParams(overrides = {}) {
  return {
    campaign_id: "campaign-1",
    link_video: "https://example.com/video.mp4",
    legenda: "Legenda",
    jitter_delay_min_ms: 0,
    jitter_delay_max_ms: 0,
    random: () => 0,
    groups: [{ group_id: "group-1@g.us" }],
    ...overrides,
  };
}

// America/Bahia nao observa horario de verao desde 2019: e' sempre UTC-3.
// "07:00" na campanha tem que virar 10:00 UTC, nao 07:00 UTC (o que aconteceria
// se o fuso do processo fosse UTC, como acontece em qualquer container sem
// TZ/tzdata configurados).
async function testJanelaConverteParaUtcUsandoFusoDaCampanha() {
  // 12:00 UTC e' 09:00 em America/Bahia (UTC-3): dia 23 nos dois fusos, sem
  // ambiguidade de "qual dia calendario" - isso e' coberto pelo proximo teste.
  const schedule = buildJitteredDispatchSchedule(createBaseParams({
    execution_at: "2026-08-23T12:00:00.000Z",
    window_start: "07:00",
    window_end: "08:00",
    timezone: "America/Bahia",
  }));

  assert.equal(schedule.length, 1);
  assert.equal(
    schedule[0].scheduled_at,
    "2026-08-23T10:00:00.000Z",
    "07:00 em America/Bahia (UTC-3) deve virar 10:00 UTC, independente do fuso do processo que roda o teste"
  );
}

// O "dia calendario" da janela deve ser o dia em que execution_at cai QUANDO
// OBSERVADO no fuso da campanha, nao no fuso do processo. execution_at as
// 23:30 UTC de 22/08 e' 20:30 em America/Bahia (UTC-3): ainda dia 22 la.
async function testDiaDaJanelaUsaFusoDaCampanhaNaoDoProcesso() {
  const schedule = buildJitteredDispatchSchedule(createBaseParams({
    execution_at: "2026-08-22T23:30:00.000Z",
    window_start: "22:00",
    window_end: "23:00",
    timezone: "America/Bahia",
  }));

  assert.equal(schedule.length, 1);
  assert.equal(
    schedule[0].scheduled_at,
    "2026-08-23T01:00:00.000Z",
    "22:00 em Bahia no dia 22 (fuso local) deve virar 01:00 UTC do dia 23, e nao usar o dia 23 UTC como base"
  );
}

// Janela cruzando meia-noite ("22:00"-"02:00"): o fim tem que cair no dia
// seguinte no fuso da CAMPANHA. Testado com um terceiro fuso (nem UTC nem
// America/Bahia) para garantir que a conversao nao depende de coincidencia
// entre TZ do processo e o fuso passado.
async function testJanelaCruzandoMeiaNoiteUsaFusoDaCampanha() {
  const window = normalizeDispatchWindow({
    execution_at: "2026-08-23T12:00:00.000Z",
    window_start: "22:00",
    window_end: "02:00",
    timezone: "America/Sao_Paulo",
  });

  // 22:00 em Sao_Paulo (UTC-3, sem horario de verao desde 2019) no dia 23 = 01:00 UTC do dia 24.
  assert.equal(window.start.toISOString(), "2026-08-24T01:00:00.000Z");
  // 02:00 no dia SEGUINTE (24) em Sao_Paulo = 05:00 UTC do dia 24 - fechando uma janela de
  // exatamente 4h (22h as 2h). O que a conversao antiga (end.setDate no fuso do processo)
  // podia produzir por engano, perto da fronteira de dia entre TZ e CAMPAIGN_TIMEZONE, era
  // avancar o dia ERRADO e alterar a duracao da janela.
  assert.equal(window.end.toISOString(), "2026-08-24T05:00:00.000Z");
  assert.equal(
    window.end.getTime() - window.start.getTime(),
    4 * 60 * 60 * 1000,
    "janela de 22:00 as 02:00 deve durar exatamente 4h, independente do fuso"
  );
}

// Sem `timezone` explicito, cai em CAMPAIGN_TIMEZONE (mesma cadeia de
// getCampaignTimezone em campaign-trigger.js) - compatibilidade com todo
// caller existente, que nunca passou este parametro.
async function testSemTimezoneExplicitoUsaCampaignTimezoneEnv() {
  const original = process.env.CAMPAIGN_TIMEZONE;
  process.env.CAMPAIGN_TIMEZONE = "America/Bahia";

  try {
    const schedule = buildJitteredDispatchSchedule(createBaseParams({
      execution_at: "2026-08-23T12:00:00.000Z",
      window_start: "07:00",
      window_end: "08:00",
    }));

    assert.equal(schedule[0].scheduled_at, "2026-08-23T10:00:00.000Z");
  } finally {
    if (original === undefined) delete process.env.CAMPAIGN_TIMEZONE;
    else process.env.CAMPAIGN_TIMEZONE = original;
  }
}

async function main() {
  await testJanelaConverteParaUtcUsandoFusoDaCampanha();
  await testDiaDaJanelaUsaFusoDaCampanhaNaoDoProcesso();
  await testJanelaCruzandoMeiaNoiteUsaFusoDaCampanha();
  await testSemTimezoneExplicitoUsaCampaignTimezoneEnv();
  console.log("dispatch jitter timezone tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
