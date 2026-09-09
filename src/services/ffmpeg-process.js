/*
  Execucao de um processo ffmpeg, com o timeout sob controle deste modulo.

  POR QUE ISTO EXISTE, EM VEZ DA OPCAO `timeout` DO spawn.

  video-audio-extraction.js e video-compression.js tinham cada um o seu
  `runFfmpeg`, praticamente identicos, e os dois passavam `timeout` para o
  `spawn` do Node. Essa opcao vaza um timer quando o processo NAO CONSEGUE
  NASCER, e o vazamento dura o valor inteiro do timeout - 10 minutos, no padrao
  daqui.

  A causa esta na implementacao do proprio Node (lib/child_process.js): a opcao
  `timeout` agenda um setTimeout e o cancela em UM unico lugar,
  `child.once("exit", ...)`. Mas um spawn que falha por ENOENT (binario ausente,
  FFMPEG_PATH apontando para caminho errado) emite `error` e `close` e NUNCA
  emite `exit` - o processo nao existiu, logo nao saiu. O timer fica pendente,
  sem ninguem para limpa-lo, mantendo o event loop vivo.

  Comprovado com um spawn de caminho inexistente e `timeout: 5000`:
  os eventos emitidos foram `error,close`, `process.getActiveResourcesInfo()`
  ainda listava um `Timeout` depois do close, e o processo so encerrou aos
  5012 ms - exatamente o valor do timeout.

  Duas consequencias, uma em teste e uma em producao:

    - EM TESTE: tests/video-audio-extraction.test.js exercita de proposito o
      caminho "ffmpeg nao encontrado". O teste imprimia "OK" e o processo ficava
      preso mais 10 minutos, o que era lido como suite travada (era o unico
      arquivo que nao completava no `npm test`). Nota: uma tentativa anterior
      de correcao atribuiu o travamento a um pipe de stderr nao drenado - estava
      errado, e foi revertida. O sintoma "imprime OK e so depois nao encerra"
      aponta handle pendente, nao deadlock de escrita.

    - EM PRODUCAO: cada extracao/compressao que erra por ENOENT deixa um timer
      de 10 minutos no processo da API ou do worker. Segura o desligamento
      graciosos por todo esse tempo e, quando dispara, chama kill() num filho que
      nunca existiu.

  Aqui o timer e' nosso e e' limpo tanto no `close` quanto no `error`, que sao os
  dois desfechos possiveis. De brinde, o estouro de tempo passa a ter mensagem
  propria: antes o kill por timeout chegava ao chamador como
  "code null, signal SIGTERM", indistinguivel de um ffmpeg morto por outro
  motivo.
*/
const { spawn } = require("node:child_process");

const DEFAULT_FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_KILL_SIGNAL = "SIGTERM";

function resolveTimeoutMs(options = {}) {
  const configured = Number(options.timeoutMs);

  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_FFMPEG_TIMEOUT_MS;
  }

  return Math.trunc(configured);
}

function buildFfmpegNotFoundError(ffmpegPath) {
  return new Error(
    `ffmpeg nao encontrado em "${ffmpegPath}". Instale as dependencias do projeto (npm install) ou defina FFMPEG_PATH.`
  );
}

/*
  Roda o ffmpeg e resolve com o desfecho, sem julgar o codigo de saida - quem
  chama decide o que e' falha (probeDurationSeconds, por exemplo, espera codigo 1
  de proposito: `ffmpeg -i arquivo` sem output sai 1 mas imprime a duracao).

  Resolve: { code, signal, stderr, timedOut }
  Rejeita: apenas quando o processo nao pode ser iniciado (ENOENT e afins).
*/
function runFfmpegProcess(ffmpegPath, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = resolveTimeoutMs(options);
    const killSignal = options.killSignal || DEFAULT_KILL_SIGNAL;

    // Sem a opcao `timeout` do spawn - ver o cabecalho deste arquivo.
    const child = spawn(ffmpegPath, args, { windowsHide: true });

    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timeoutId = null;

    function clearPendingTimeout() {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    }

    // Um unico ponto de saida: garante que o timer morre em qualquer desfecho, e
    // que um `error` seguido de `close` (o que acontece no ENOENT) nao tente
    // resolver depois de ja ter rejeitado.
    function settle(action, value) {
      if (settled) {
        return;
      }

      settled = true;
      clearPendingTimeout();
      action(value);
    }

    timeoutId = setTimeout(() => {
      timedOut = true;
      timeoutId = null;

      try {
        child.kill(killSignal);
      } catch {
        // Filho ja morto entre o disparo do timer e o kill: o `close` que vem a
        // seguir (ou o que ja veio) e' quem resolve.
      }
    }, timeoutMs);

    // Um "error" sem listener num stream e excecao nao capturada, que mata o
    // processo inteiro. Os pipes do ffmpeg podem errar (EPIPE/ECONNRESET) quando o
    // processo e derrubado pelo timeout no meio de um video longo - e isto roda
    // dentro da API, entao levaria o servidor junto. O desfecho real vem de
    // "error"/"close" no proprio child; aqui so evitamos o evento solto.
    child.stderr &&
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
    child.stderr && child.stderr.on("error", () => {});
    child.stdout && child.stdout.on("error", () => {});

    child.on("error", (error) => {
      if (error && error.code === "ENOENT") {
        settle(reject, buildFfmpegNotFoundError(ffmpegPath));

        return;
      }

      settle(reject, error);
    });

    child.on("close", (code, signal) => {
      settle(resolve, { code, signal, stderr, timedOut });
    });
  });
}

// Mensagem de estouro de tempo. Deliberadamente NAO usa a expressao
// "Tempo limite excedido": essa frase e' um dos padroes que
// queues/dispatch-failure-retry.js trata como falha permanente de envio, e um
// ffmpeg lento nao e' isso.
function buildFfmpegTimeoutMessage(action, timeoutMs) {
  return `ffmpeg excedeu o tempo limite de ${timeoutMs}ms ao ${action}`;
}

module.exports = {
  DEFAULT_FFMPEG_TIMEOUT_MS,
  buildFfmpegNotFoundError,
  buildFfmpegTimeoutMessage,
  resolveTimeoutMs,
  runFfmpegProcess,
};
