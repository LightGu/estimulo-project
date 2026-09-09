const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_FFMPEG_TIMEOUT_MS,
  buildFfmpegTimeoutMessage,
  resolveTimeoutMs,
  runFfmpegProcess,
} = require("../src/services/ffmpeg-process");
const { extractAudioFromVideo, resolveFfmpegPath } = require("../src/services/video-audio-extraction");

/*
  Regressao do vazamento de timer que travava a suite.

  tests/video-audio-extraction.test.js imprimia "video-audio-extraction tests OK"
  e o processo ficava vivo mais 10 minutos - era o unico arquivo que nao
  completava no `npm test`. A causa nao era a suite: era a opcao `timeout` do
  `spawn` do Node, usada pelos dois modulos de ffmpeg.

  O Node agenda o timer dessa opcao e o cancela em um unico lugar,
  `child.once("exit", ...)`. Um spawn que falha por ENOENT emite `error` e
  `close` e NUNCA emite `exit` - o processo nao nasceu, logo nao saiu. O timer
  fica pendente pelo valor inteiro do timeout, segurando o event loop.

  E o teste exercitava exatamente esse caminho ("ffmpeg nao encontrado"), com o
  padrao de 10 minutos.

  Isto nao era so um incomodo de teste: no servidor, cada extracao ou
  compressao que erra por ENOENT (FFMPEG_PATH errado, imagem sem o binario)
  deixava um timer de 10 minutos no processo da API ou do worker, atrasando o
  desligamento graciosos por todo esse tempo.

  Os testes abaixo medem o vazamento pelo que ele e', em vez de so verificar a
  mensagem de erro: contam os handles de timer que sobram depois do desfecho.
*/

// Este arquivo roda com o event loop limpo (nenhuma fila, nenhum servidor), o
// que torna a contagem de timers pendentes uma medida confiavel. `Timeout` e o
// nome que getActiveResourcesInfo da tanto para setTimeout quanto setInterval.
function pendingTimers() {
  if (typeof process.getActiveResourcesInfo !== "function") {
    return null;
  }

  return process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
}

const FFMPEG_INEXISTENTE = path.join(os.tmpdir(), "ffmpeg-que-nao-existe-regressao");

// 1. O CASO QUE TRAVAVA A SUITE. Um timeout longo com binario ausente: antes,
//    o timer de 10 min sobrevivia a rejeicao e mantinha o processo vivo. Ele
//    tinha de ser longo para o sintoma aparecer - com timeout curto o processo
//    "so" demorava um pouco a sair, e ninguem notava.
async function testEnoentNaoDeixaTimerPendente() {
  const antes = pendingTimers();

  await assert.rejects(
    () => runFfmpegProcess(FFMPEG_INEXISTENTE, ["-version"], { timeoutMs: 10 * 60 * 1000 }),
    /ffmpeg nao encontrado/
  );

  const depois = pendingTimers();

  if (antes === null) {
    return;
  }

  assert.equal(
    depois,
    antes,
    `sobrou ${depois - antes} timer(s) pendente(s) depois do ENOENT. ` +
      "Era esse vazamento que mantinha o processo do teste vivo por 10 minutos " +
      "(o spawn do Node so limpa o timer da opcao `timeout` no evento `exit`, que " +
      "um spawn falhado nunca emite)."
  );
}

// 2. E o mesmo pelo caminho publico, que e' o que o teste travado exercitava -
//    garante que a correcao esta no caminho de verdade, nao so no helper.
async function testExtracaoComFfmpegAusenteEncerraLimpa() {
  const antes = pendingTimers();

  await assert.rejects(
    () =>
      extractAudioFromVideo(
        { bytes: Buffer.from("video-bytes"), mime_type: "video/mp4", name: "aula-01.mp4" },
        { ffmpegPath: FFMPEG_INEXISTENTE, timeoutMs: 10 * 60 * 1000 }
      ),
    /ffmpeg nao encontrado/
  );

  if (antes === null) {
    return;
  }

  assert.equal(pendingTimers(), antes, "extractAudioFromVideo deixou timer pendente apos ENOENT");
}

// 3. O timeout continua FUNCIONANDO. Tirar a opcao `timeout` do spawn para
//    resolver o vazamento nao pode ter tirado o teto de duracao junto - um
//    ffmpeg travado num video corrompido tem de morrer.
async function testTimeoutAindaMataOProcesso() {
  const antes = pendingTimers();
  const iniciadoEm = Date.now();

  // Encode 1080p de 30s com o proprio ffmpeg como fonte: leva bem mais que os
  // 400ms de teto, entao o kill e' deterministico. `-f null -` descarta a saida.
  const resultado = await runFfmpegProcess(
    resolveFfmpegPath(),
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=30:size=1920x1080:rate=30",
      "-c:v",
      "libx264",
      "-preset",
      "veryslow",
      "-f",
      "null",
      "-",
    ],
    { timeoutMs: 400 }
  );

  const duracao = Date.now() - iniciadoEm;

  assert.equal(resultado.timedOut, true, `esperava timedOut=true, veio ${JSON.stringify(resultado)}`);
  assert.notEqual(resultado.code, 0, "um ffmpeg morto pelo timeout nao pode reportar sucesso");
  assert.ok(duracao < 30000, `o processo deveria ter sido morto em ~400ms, levou ${duracao}ms`);

  if (antes !== null) {
    assert.equal(pendingTimers(), antes, "o timer do timeout tem de ser limpo tambem quando ele dispara");
  }
}

// 4. O estouro de tempo tem mensagem propria, e ela NAO colide com o
//    classificador de falha permanente de envio. dispatch-failure-retry.js trata
//    "Tempo limite excedido" como falha permanente (e' o timeout da Evolution);
//    um ffmpeg lento nao e' isso e nao pode herdar essa classificacao.
function testMensagemDeTimeoutNaoColideComFalhaPermanente() {
  const mensagem = buildFfmpegTimeoutMessage("recomprimir o video", 1200000);

  assert.match(mensagem, /excedeu o tempo limite de 1200000ms/);
  assert.equal(
    /Tempo limite excedido/i.test(mensagem),
    false,
    "a mensagem casaria com PERMANENT_FAILURE_PATTERNS de dispatch-failure-retry.js e " +
      "um ffmpeg lento seria classificado como falha permanente de envio"
  );
}

// 5. Default e saneamento do teto, para uma configuracao invalida nao virar
//    "sem timeout" (que era o efeito de passar 0 para a opcao do spawn).
function testResolveTimeoutMs() {
  assert.equal(resolveTimeoutMs({}), DEFAULT_FFMPEG_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs({ timeoutMs: 0 }), DEFAULT_FFMPEG_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs({ timeoutMs: -5 }), DEFAULT_FFMPEG_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs({ timeoutMs: "abc" }), DEFAULT_FFMPEG_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs({ timeoutMs: 1500.9 }), 1500);
}

async function main() {
  await testEnoentNaoDeixaTimerPendente();
  await testExtracaoComFfmpegAusenteEncerraLimpa();
  await testTimeoutAindaMataOProcesso();
  testMensagemDeTimeoutNaoColideComFalhaPermanente();
  testResolveTimeoutMs();

  console.log("ffmpeg-process timeout tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
