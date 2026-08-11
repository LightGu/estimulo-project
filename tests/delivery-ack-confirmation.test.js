const assert = require("assert");

const {
  GROUP_UNCONFIRMED_PROVIDER_STATUS,
  UNVERIFIED_PROVIDER_STATUS,
  classifyProviderAck,
  confirmProviderDelivery,
  extractInstanceNameFromEndpoint,
  extractProviderDelivery,
  isGroupJid,
} = require("../src/services/delivery-confirmation");

const BASE_CONFIG = { enabled: true, timeoutMs: 30000, pollIntervalMs: 5000 };
const DIRECT_JID = "5511999999999@s.whatsapp.net";

function buildAcceptedResponse(overrides = {}) {
  const { key: keyOverrides, ...dataOverrides } = overrides;

  return {
    provider: "evolution",
    endpoint: "/message/sendMedia/estimulo-mvp",
    status: 201,
    data: {
      key: { id: "3EB0ABC", remoteJid: "120363000000000000@g.us", fromMe: true, ...keyOverrides },
      status: "PENDING",
      ...dataOverrides,
    },
  };
}

function buildDirectResponse(overrides = {}) {
  return buildAcceptedResponse({ ...overrides, key: { remoteJid: DIRECT_JID } });
}

// Relogio e espera controlados: o teste precisa exercitar o tempo limite de 90s
// sem gastar 90s reais.
function buildClock() {
  let current = 0;

  return {
    now: () => current,
    wait: async (ms) => {
      current += ms;
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

function buildReader(sequence) {
  const calls = [];
  const queue = [...sequence];

  return {
    calls,
    async findMessageAckStatus(messageId) {
      calls.push(messageId);
      return queue.length > 1 ? queue.shift() : queue[0];
    },
  };
}

function testClassifyProviderAck() {
  assert.equal(classifyProviderAck("SERVER_ACK"), "confirmado");
  assert.equal(classifyProviderAck("delivery_ack"), "confirmado");
  assert.equal(classifyProviderAck("READ"), "confirmado");
  assert.equal(classifyProviderAck("PLAYED"), "confirmado");
  assert.equal(classifyProviderAck("PENDING"), "aguardando");
  assert.equal(classifyProviderAck("ERROR"), "falhou");
  assert.equal(classifyProviderAck(""), "desconhecido");
  assert.equal(classifyProviderAck(null), "desconhecido");
}

function testExtractInstanceNameFromEndpoint() {
  assert.equal(extractInstanceNameFromEndpoint("/message/sendMedia/estimulo-mvp"), "estimulo-mvp");
  assert.equal(extractInstanceNameFromEndpoint("/message/sendText/numero-2"), "numero-2");
  assert.equal(extractInstanceNameFromEndpoint(null), null);
}

async function testConfirmsWhenWhatsappAcks() {
  const clock = buildClock();
  const reader = buildReader([{ found: true, status: "PENDING" }, { found: true, status: "DELIVERY_ACK" }]);

  const confirmation = await confirmProviderDelivery(buildAcceptedResponse(), {
    config: BASE_CONFIG,
    logger: { info() {}, warn() {}, error() {} },
    messageStatusReader: reader,
    now: clock.now,
    wait: clock.wait,
  });

  assert.deepEqual(confirmation, {
    confirmed: true,
    verified: true,
    provider_message_id: "3EB0ABC",
    provider_status: "DELIVERY_ACK",
  });
  assert.equal(reader.calls.length, 2, "deve consultar de novo enquanto o ACK nao chega");
}

// Fora de grupo o ACK e confiavel, entao a ausencia dele significa mesmo que a
// mensagem nao saiu - continua reprovando.
async function testFailsWhenAckNeverArrivesOutsideGroup() {
  const clock = buildClock();
  const reader = buildReader([{ found: true, status: "PENDING" }]);

  await assert.rejects(
    () =>
      confirmProviderDelivery(buildDirectResponse(), {
        config: BASE_CONFIG,
        logger: { info() {}, warn() {}, error() {} },
        messageStatusReader: reader,
        now: clock.now,
        wait: clock.wait,
      }),
    (error) => {
      assert.equal(error.code, "DELIVERY_NOT_CONFIRMED");
      assert.equal(error.providerStatus, "PENDING");
      assert.match(error.message, /nao confirmou a entrega em 30s/);
      return true;
    }
  );
}

// O bug que este arquivo passou a cobrir: o WhatsApp nao devolve ACK de mensagem
// enviada a grupo (todas ficam em PENDING para sempre, sem linha em
// MessageUpdate). Reprovar por isso marcava "Falhou" em video que chegou ao
// grupo, notificava falha e liberava o sweep para reenviar o mesmo video.
async function testGroupWithoutAckIsNotFailure() {
  const clock = buildClock();
  const reader = buildReader([{ found: true, status: "PENDING" }]);

  const confirmation = await confirmProviderDelivery(buildAcceptedResponse(), {
    config: BASE_CONFIG,
    logger: { info() {}, warn() {}, error() {} },
    messageStatusReader: reader,
    now: clock.now,
    wait: clock.wait,
  });

  assert.equal(confirmation.confirmed, false, "sem ACK nao pode afirmar entrega");
  assert.equal(confirmation.verified, true, "a consulta funcionou - so nao existe ACK de grupo");
  assert.equal(confirmation.group_without_ack, true);
  assert.equal(confirmation.message_persisted, true);
  assert.equal(confirmation.provider_status, GROUP_UNCONFIRMED_PROVIDER_STATUS);
  assert.equal(confirmation.provider_message_id, "3EB0ABC");
}

// Mesmo sem a mensagem aparecer no banco da Evolution, grupo nao vira falha - a
// evidencia so fica mais fraca, e o log registra isso.
async function testGroupWithoutPersistedMessageIsNotFailure() {
  const clock = buildClock();
  const reader = buildReader([{ found: false, status: null }]);

  const confirmation = await confirmProviderDelivery(buildAcceptedResponse(), {
    config: BASE_CONFIG,
    logger: { info() {}, warn() {}, error() {} },
    messageStatusReader: reader,
    now: clock.now,
    wait: clock.wait,
  });

  assert.equal(confirmation.confirmed, false);
  assert.equal(confirmation.message_persisted, false);
  assert.equal(confirmation.provider_status, GROUP_UNCONFIRMED_PROVIDER_STATUS);
}

// Esperar os 90s cheios por um ACK que nunca vem ocupava o worker e atrasava o
// relatorio; grupo usa a janela curta propria.
async function testGroupUsesShortWindow() {
  const clock = buildClock();
  const reader = buildReader([{ found: true, status: "PENDING" }]);

  await confirmProviderDelivery(buildAcceptedResponse(), {
    config: { ...BASE_CONFIG, timeoutMs: 90000, groupTimeoutMs: 15000 },
    logger: { info() {}, warn() {}, error() {} },
    messageStatusReader: reader,
    now: clock.now,
    wait: clock.wait,
  });

  assert.ok(clock.now() <= 15000, `janela de grupo deveria parar em 15s, parou em ${clock.now()}ms`);
  assert.ok(reader.calls.length <= 4, `esperado no maximo 4 consultas na janela curta, houve ${reader.calls.length}`);
}

// A regra de grupo afrouxa a ausencia de ACK, nunca uma recusa: ACK de erro em
// grupo continua reprovando o envio.
async function testGroupStillFailsOnProviderError() {
  const clock = buildClock();
  const reader = buildReader([{ found: true, status: "SERVER_ERROR" }]);

  await assert.rejects(
    () =>
      confirmProviderDelivery(buildAcceptedResponse(), {
        config: BASE_CONFIG,
        logger: { info() {}, warn() {}, error() {} },
        messageStatusReader: reader,
        now: clock.now,
        wait: clock.wait,
      }),
    (error) => {
      assert.equal(error.code, "DELIVERY_NOT_CONFIRMED");
      assert.equal(error.providerStatus, "SERVER_ERROR");
      return true;
    }
  );
}

// Grupo com ACK de verdade (caso que existe fora de grupo, e que passaria a
// existir em grupo se a Evolution comecar a gravar) segue como confirmado.
async function testGroupWithAckIsConfirmed() {
  const clock = buildClock();
  const reader = buildReader([{ found: true, status: "DELIVERY_ACK" }]);

  const confirmation = await confirmProviderDelivery(buildAcceptedResponse(), {
    config: BASE_CONFIG,
    logger: { info() {}, warn() {}, error() {} },
    messageStatusReader: reader,
    now: clock.now,
    wait: clock.wait,
  });

  assert.equal(confirmation.confirmed, true);
  assert.equal(confirmation.provider_status, "DELIVERY_ACK");
}

function testIsGroupJid() {
  assert.equal(isGroupJid("120363000000000000@g.us"), true);
  assert.equal(isGroupJid("120363000000000000@G.US"), true);
  assert.equal(isGroupJid(DIRECT_JID), false);
  assert.equal(isGroupJid(null), false);
  assert.equal(isGroupJid(""), false);
}

async function testFailsImmediatelyOnProviderError() {
  const clock = buildClock();
  const reader = buildReader([{ found: true, status: "ERROR" }]);

  await assert.rejects(
    () =>
      confirmProviderDelivery(buildAcceptedResponse(), {
        config: BASE_CONFIG,
        logger: { info() {}, warn() {}, error() {} },
        messageStatusReader: reader,
        now: clock.now,
        wait: clock.wait,
      }),
    (error) => {
      assert.equal(error.code, "DELIVERY_NOT_CONFIRMED");
      assert.equal(error.providerStatus, "ERROR");
      return true;
    }
  );

  assert.equal(reader.calls.length, 1, "estado de erro nao precisa de nova consulta");
}

// Banco da Evolution inalcancavel nao pode reprovar um envio que talvez tenha
// dado certo - mas o log tem de dizer que ninguem confirmou nada.
async function testUnverifiedWhenLookupUnavailable() {
  const clock = buildClock();
  const reader = buildReader([null]);
  const warnings = [];

  const confirmation = await confirmProviderDelivery(buildAcceptedResponse(), {
    config: BASE_CONFIG,
    logger: { info() {}, warn: (line) => warnings.push(line), error() {} },
    messageStatusReader: reader,
    now: clock.now,
    wait: clock.wait,
  });

  assert.equal(confirmation.confirmed, false);
  assert.equal(confirmation.verified, false);
  assert.equal(confirmation.provider_status, UNVERIFIED_PROVIDER_STATUS);
  assert.equal(reader.calls.length, 1, "nao deve insistir quando a consulta esta indisponivel");
  assert.match(warnings.join(" "), /delivery_confirmation.unverified/);
}

async function testDisabledConfirmationKeepsLegacyBehaviour() {
  const confirmation = await confirmProviderDelivery(buildAcceptedResponse(), {
    config: { ...BASE_CONFIG, enabled: false },
    logger: { info() {}, warn() {}, error() {} },
    messageStatusReader: {
      async findMessageAckStatus() {
        throw new Error("nao deveria consultar com a confirmacao desligada");
      },
    },
  });

  assert.equal(confirmation.verified, false);
  assert.equal(confirmation.provider_status, UNVERIFIED_PROVIDER_STATUS);
}

// A evidencia gravada no log tem de ser o ACK final, nao o "PENDING" do aceite.
function testExtractProviderDeliveryPrefersConfirmation() {
  const accepted = buildAcceptedResponse();

  assert.deepEqual(extractProviderDelivery(accepted), {
    provider_message_id: "3EB0ABC",
    provider_status: "PENDING",
  });

  accepted.delivery_confirmation = {
    confirmed: true,
    verified: true,
    provider_message_id: "3EB0ABC",
    provider_status: "READ",
  };

  assert.deepEqual(extractProviderDelivery(accepted), {
    provider_message_id: "3EB0ABC",
    provider_status: "READ",
  });
}

async function run() {
  testClassifyProviderAck();
  testExtractInstanceNameFromEndpoint();
  testIsGroupJid();
  await testConfirmsWhenWhatsappAcks();
  await testFailsWhenAckNeverArrivesOutsideGroup();
  await testGroupWithoutAckIsNotFailure();
  await testGroupWithoutPersistedMessageIsNotFailure();
  await testGroupUsesShortWindow();
  await testGroupStillFailsOnProviderError();
  await testGroupWithAckIsConfirmed();
  await testFailsImmediatelyOnProviderError();
  await testUnverifiedWhenLookupUnavailable();
  await testDisabledConfirmationKeepsLegacyBehaviour();
  testExtractProviderDeliveryPrefersConfirmation();

  console.log("delivery-ack-confirmation.test.js OK");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
