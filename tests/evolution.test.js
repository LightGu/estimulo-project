const assert = require("node:assert/strict");

const {
  EvolutionApiError,
  EvolutionDeliveryProvider,
  assertMediaPayloadWithinLimit,
  isPermanentEvolutionStatus,
  parseEvolutionError,
  summarizeEvolutionResponseError,
} = require("../src/services/evolution");

function testPreservesHttpStatusAndProviderMessage() {
  const error = parseEvolutionError({
    response: {
      status: 403,
      data: { message: "Grupo nao esta disponivel nesta instancia" },
    },
  });

  assert.ok(error instanceof EvolutionApiError);
  assert.equal(error.status, 403);
  assert.equal(
    error.message,
    "Falha na chamada para Evolution API (HTTP 403: Grupo nao esta disponivel nesta instancia)"
  );
}

function testResponseErrorSummaryIsSafeForLogs() {
  assert.equal(summarizeEvolutionResponseError({ data: { error: { message: "  Falha\n detalhada " } } }), "Falha detalhada");
  assert.equal(summarizeEvolutionResponseError({ data: { message: "x".repeat(600) } }).length, 500);
}

// O handler global de erro da Evolution responde
// `{ status, error: "Internal Server Error", response: { message } }`. Preferir
// `error` escondia a causa: um 413 do body-parser chegava no log como
// "Internal Server Error" e nao dizia que o payload passou do limite.
function testPrefersNestedResponseMessageOverGenericError() {
  assert.equal(
    summarizeEvolutionResponseError({
      data: {
        status: 413,
        error: "Internal Server Error",
        response: { message: "request entity too large" },
      },
    }),
    "request entity too large"
  );

  // O 404 da Evolution devolve `response.message` como array.
  assert.equal(
    summarizeEvolutionResponseError({
      data: { status: 404, error: "Not Found", response: { message: ["Cannot POST /message/sendMedia/x"] } },
    }),
    "Cannot POST /message/sendMedia/x"
  );

  // Sem `response.message`, o texto generico ainda e melhor que nada.
  assert.equal(
    summarizeEvolutionResponseError({ data: { error: "Internal Server Error" } }),
    "Internal Server Error"
  );

  // Corpo real do 400 de destinatario inexistente: lista de objetos, nao texto.
  // Serializar preserva o `exists: false`, que e exatamente o diagnostico util.
  assert.equal(
    summarizeEvolutionResponseError({
      data: {
        status: 400,
        error: "Bad Request",
        response: { message: [{ jid: "@s.whatsapp.net", exists: false, number: "invalido" }] },
      },
    }),
    '{"jid":"@s.whatsapp.net","exists":false,"number":"invalido"}'
  );

  assert.equal(summarizeEvolutionResponseError({ data: {} }), null);
  assert.equal(summarizeEvolutionResponseError({}), null);
  assert.equal(summarizeEvolutionResponseError({ data: { error: "   " } }), null);
}

function testPayloadTooLargeIsExplainedAndMarkedPermanent() {
  const error = parseEvolutionError({
    response: {
      status: 413,
      data: { status: 413, error: "Internal Server Error", response: { message: "Internal Server Error" } },
    },
  });

  assert.equal(error.status, 413);
  assert.equal(error.code, "EVOLUTION_PAYLOAD_TOO_LARGE");
  assert.equal(error.permanent, true);
  assert.match(error.message, /limite de corpo da requisicao/);
  assert.match(error.message, /base64/);
}

function testTransientStatusesStayRetryable() {
  assert.equal(isPermanentEvolutionStatus(413), true);
  assert.equal(isPermanentEvolutionStatus(400), true);
  assert.equal(isPermanentEvolutionStatus(500), false);
  assert.equal(isPermanentEvolutionStatus(502), false);
  assert.equal(isPermanentEvolutionStatus(429), false);

  const timeout = parseEvolutionError({ request: {}, code: "ECONNABORTED", message: "timeout of 90000ms exceeded" });

  assert.equal(timeout.code, "EVOLUTION_TIMEOUT");
  assert.equal(timeout.permanent, false);
}

function testMediaPayloadLimitGuard() {
  const config = { maxMediaPayloadBytes: 1024 };

  // Texto puro (sem `media`) nunca e barrado por tamanho de midia.
  assertMediaPayloadWithinLimit({ number: "x@g.us", text: "ok" }, config);
  assertMediaPayloadWithinLimit({ number: "x@g.us", media: "a".repeat(100) }, config);

  assert.throws(
    () => assertMediaPayloadWithinLimit({ number: "x@g.us", media: "a".repeat(2048) }, config),
    (error) => {
      assert.ok(error instanceof EvolutionApiError);
      assert.equal(error.code, "EVOLUTION_PAYLOAD_TOO_LARGE");
      assert.equal(error.permanent, true);
      assert.match(error.message, /excede o limite de 1024 bytes/);

      return true;
    }
  );

  // Limite ausente/invalido nao pode bloquear envio.
  assertMediaPayloadWithinLimit({ media: "a".repeat(2048) }, {});
  assertMediaPayloadWithinLimit({ media: "a".repeat(2048) }, { maxMediaPayloadBytes: 0 });
}

// O guard tem de rodar ANTES do POST: era justamente o upload inteiro de um
// payload condenado a 413 que se queria evitar.
async function testProviderBlocksOversizedMediaBeforeRequest() {
  let posted = false;
  const provider = new EvolutionDeliveryProvider({
    config: { baseUrl: "http://localhost:8080", apiKey: "k", instanceName: "i", maxMediaPayloadBytes: 512 },
    client: {
      post() {
        posted = true;

        return Promise.resolve({ status: 200, data: {} });
      },
    },
  });

  await assert.rejects(
    () =>
      provider.send({
        groupId: "120363410329160839@g.us",
        message: "legenda",
        content: { base64: "a".repeat(4096), fileName: "video.mp4", mimeType: "video/mp4", type: "video" },
      }),
    /excede o limite de 512 bytes/
  );

  assert.equal(posted, false, "o POST nao pode ser disparado com payload acima do limite");
}

(async () => {
  testPreservesHttpStatusAndProviderMessage();
  testResponseErrorSummaryIsSafeForLogs();
  testPrefersNestedResponseMessageOverGenericError();
  testPayloadTooLargeIsExplainedAndMarkedPermanent();
  testTransientStatusesStayRetryable();
  testMediaPayloadLimitGuard();
  await testProviderBlocksOversizedMediaBeforeRequest();

  console.log("evolution tests OK");
})();
