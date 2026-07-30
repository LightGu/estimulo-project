const assert = require("node:assert/strict");

const {
  SkippableModelError,
  describeFetchFailure,
  fetchWithRetry,
  isTransientNetworkError,
  readResponseJson,
} = require("../src/services/ai/http-utils");
const { GeminiAdapter } = require("../src/services/ai/gemini-adapter");

// Reproduz o erro que o fetch do Node levanta quando a conexao cai: TypeError
// "fetch failed" com o motivo real escondido em `cause`.
function buildFetchFailedError(code = "ECONNRESET", message = "read ECONNRESET") {
  const error = new TypeError("fetch failed");
  const cause = new Error(message);

  cause.code = code;
  error.cause = cause;

  return error;
}

function testIdentifiesTransientNetworkFailures() {
  assert.equal(isTransientNetworkError(buildFetchFailedError()), true);
  assert.equal(isTransientNetworkError(buildFetchFailedError("ENOTFOUND", "getaddrinfo ENOTFOUND")), true);
  assert.equal(isTransientNetworkError(buildFetchFailedError("UND_ERR_SOCKET", "other side closed")), true);
  assert.equal(isTransientNetworkError(new TypeError("fetch failed")), true);

  // Erros de logica/HTTP nao sao de rede e nao devem ser repetidos.
  assert.equal(isTransientNetworkError(new Error("Gemini nao retornou legenda em texto")), false);
  assert.equal(isTransientNetworkError(new SkippableModelError("quota exceeded")), false);
  assert.equal(isTransientNetworkError(null), false);
}

function testDescribesFetchFailureWithUnderlyingCause() {
  const described = describeFetchFailure(buildFetchFailedError("ECONNRESET", "read ECONNRESET"), "Gerar legenda");

  assert.match(described, /Gerar legenda/);
  assert.match(described, /fetch failed/);
  // O codigo de rede e o que permite diagnosticar; sem ele sobra so "fetch failed".
  assert.match(described, /ECONNRESET/);
}

async function testRetriesTransientFailureAndSucceeds() {
  let calls = 0;
  const delays = [];
  const response = await fetchWithRetry(
    async () => {
      calls += 1;

      if (calls < 3) {
        throw buildFetchFailedError();
      }

      return { ok: true, status: 200 };
    },
    "https://exemplo/generateContent",
    { method: "POST" },
    { sleep: (ms) => delays.push(ms), context: "Gerar legenda" }
  );

  assert.equal(response.status, 200);
  assert.equal(calls, 3);
  // Backoff exponencial: a segunda espera precisa ser maior que a primeira.
  assert.equal(delays.length, 2);
  assert.ok(delays[1] > delays[0], `esperava backoff crescente, veio ${JSON.stringify(delays)}`);
}

async function testGivesUpAfterAttemptsWithDiagnosableMessage() {
  let calls = 0;

  await assert.rejects(
    () =>
      fetchWithRetry(
        async () => {
          calls += 1;

          throw buildFetchFailedError("EAI_AGAIN", "getaddrinfo EAI_AGAIN generativelanguage.googleapis.com");
        },
        "https://exemplo/generateContent",
        undefined,
        { sleep: () => {}, retryAttempts: 4, context: "Gerar legenda com Gemini" }
      ),
    (error) => {
      assert.equal(error.code, "AI_NETWORK_ERROR");
      assert.match(error.message, /Gerar legenda com Gemini/);
      assert.match(error.message, /4 tentativa/);
      assert.match(error.message, /EAI_AGAIN/);

      return true;
    }
  );

  assert.equal(calls, 4);
}

async function testDoesNotRetryNonNetworkErrors() {
  let calls = 0;

  await assert.rejects(
    () =>
      fetchWithRetry(
        async () => {
          calls += 1;

          throw new Error("URL invalida");
        },
        "https://exemplo",
        undefined,
        { sleep: () => {} }
      ),
    /URL invalida/
  );

  assert.equal(calls, 1, "erro que nao e de rede deve falhar na primeira tentativa");
}

// Erro HTTP continua sendo responsabilidade do readResponseJson: nao virou
// retry de rede por acidente.
async function testHttpErrorsStillClassifiedAsSkippable() {
  await assert.rejects(
    () =>
      readResponseJson(
        {
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          text: async () => JSON.stringify({ error: { message: "quota exceeded" } }),
        },
        "Falha ao gerar texto"
      ),
    (error) => {
      assert.ok(error instanceof SkippableModelError);

      return true;
    }
  );
}

// Regressao do caso real: uma queda de rede num modelo nao pode mais abortar a
// legenda inteira — antes o `fetch failed` era reerguido direto da cascata.
async function testAdapterSurvivesTransientNetworkBlip() {
  let calls = 0;
  const adapter = new GeminiAdapter({
    apiKey: "chave-de-teste",
    models: ["modelo-a", "modelo-b"],
    sleep: () => {},
    fetch: async () => {
      calls += 1;

      if (calls === 1) {
        throw buildFetchFailedError();
      }

      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "legenda gerada" }] } }] }),
      };
    },
  });

  assert.equal(await adapter.generateText("prompt"), "legenda gerada");
  assert.equal(calls, 2);
}

(async () => {
  testIdentifiesTransientNetworkFailures();
  testDescribesFetchFailureWithUnderlyingCause();
  await testRetriesTransientFailureAndSucceeds();
  await testGivesUpAfterAttemptsWithDiagnosableMessage();
  await testDoesNotRetryNonNetworkErrors();
  await testHttpErrorsStillClassifiedAsSkippable();
  await testAdapterSurvivesTransientNetworkBlip();

  console.log("ai http-utils tests OK");
})();
