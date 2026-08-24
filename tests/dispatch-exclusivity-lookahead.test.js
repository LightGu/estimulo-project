/*
  Regressao: resolveAdHocDispatchBlock consultava campanhas de video na janela
  [agora, agora+1ms]. Uma campanha de video prestes a comecar (segundos a
  frente) nao aparecia, e a mensagem pontual saia colada no inicio dela -
  exatamente a disputa pela sessao unica do WhatsApp que dispatch-exclusivity
  existe para evitar.

  A consulta agora olha `resumeBufferMs` a frente, mantendo a regra simetrica:
  se o pontual e' adiado ate `fim + buffer`, ele tambem nao deve sair no
  `buffer` que antecede um inicio.
*/
const assert = require("node:assert/strict");

const { resolveAdHocDispatchBlock } = require("../src/services/dispatch-exclusivity");

const AGORA = new Date("2026-08-23T12:00:00.000Z");

// Repositorio que so devolve a campanha se ela realmente cruzar o intervalo
// pedido - e o que permite observar a largura da janela consultada.
function repositoryComCampanha(campanha) {
  return {
    consultas: [],
    async listActiveOverlappingWindow(windowStart, windowEnd) {
      this.consultas.push({ windowStart, windowEnd });

      const inicio = new Date(campanha.window_start).getTime();
      const fim = new Date(campanha.window_end).getTime();
      const pedidoInicio = new Date(windowStart).getTime();
      const pedidoFim = new Date(windowEnd).getTime();

      return inicio <= pedidoFim && fim >= pedidoInicio ? [campanha] : [];
    },
  };
}

// Campanha comecando 30s a frente: dentro do buffer padrao de 60s.
async function testBloqueiaCampanhaPrestesAComecar() {
  const campaignsRepository = repositoryComCampanha({
    id: "campanha-video-1",
    tipo: "video",
    trilha: "Trilha X",
    window_start: "2026-08-23T12:00:30.000Z",
    window_end: "2026-08-23T13:00:00.000Z",
  });

  const block = await resolveAdHocDispatchBlock({ campaignsRepository, at: AGORA });

  assert.ok(block, "campanha comecando dentro do buffer deve bloquear a mensagem pontual");
  assert.equal(block.campaign.id, "campanha-video-1");
  assert.match(block.reason, /Trilha X/);
}

// Campanha em andamento agora: comportamento que ja existia, nao pode regredir.
async function testContinuaBloqueandoCampanhaEmAndamento() {
  const campaignsRepository = repositoryComCampanha({
    id: "campanha-video-2",
    tipo: "video",
    trilha: "Trilha Y",
    window_start: "2026-08-23T11:00:00.000Z",
    window_end: "2026-08-23T13:00:00.000Z",
  });

  const block = await resolveAdHocDispatchBlock({ campaignsRepository, at: AGORA });

  assert.ok(block, "campanha cobrindo o instante atual deve continuar bloqueando");
  assert.equal(block.campaign.id, "campanha-video-2");
}

// Campanha muito adiante (1h) nao pode bloquear: senao o pontual nunca sairia.
async function testNaoBloqueiaCampanhaDistante() {
  const campaignsRepository = repositoryComCampanha({
    id: "campanha-video-3",
    tipo: "video",
    trilha: "Trilha Z",
    window_start: "2026-08-23T13:00:00.000Z",
    window_end: "2026-08-23T14:00:00.000Z",
  });

  const block = await resolveAdHocDispatchBlock({ campaignsRepository, at: AGORA });

  assert.equal(block, null, "campanha fora do buffer nao deve bloquear o pontual");
}

// Campanha pontual nunca bloqueia outra pontual (isVideoCampaign filtra).
async function testPontualNaoBloqueiaPontual() {
  const campaignsRepository = repositoryComCampanha({
    id: "campanha-pontual",
    tipo: "pontual",
    trilha: "-",
    window_start: "2026-08-23T12:00:30.000Z",
    window_end: "2026-08-23T13:00:00.000Z",
  });

  const block = await resolveAdHocDispatchBlock({ campaignsRepository, at: AGORA });

  assert.equal(block, null, "campanha pontual nao disputa a sessao com outra pontual");
}

async function main() {
  await testBloqueiaCampanhaPrestesAComecar();
  await testContinuaBloqueandoCampanhaEmAndamento();
  await testNaoBloqueiaCampanhaDistante();
  await testPontualNaoBloqueiaPontual();
  console.log("dispatch exclusivity lookahead tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
