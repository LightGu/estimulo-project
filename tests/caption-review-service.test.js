const assert = require("node:assert/strict");
const process = require("node:process");

const { createCaptionReviewService } = require("../src/services/caption-review.service");
const { SkippableModelError } = require("../src/services/ai/http-utils");

function createSilentLogger() {
  return { info() {}, warn() {} };
}

function createAdapter(behaviour) {
  return {
    async reviewCaptionConsistency(params) {
      return behaviour(params);
    },
  };
}

const CAPTION = "Legenda coerente com o video";
const TRANSCRIPT = "Transcricao real do video";

async function testApprovesWhenModelApproves() {
  const service = createCaptionReviewService({
    logger: createSilentLogger(),
    aiProviderAdapter: createAdapter(async () => '{"approved":true,"reason":"Coerente"}'),
  });

  const review = await service.reviewCaption({ caption: CAPTION, transcript: TRANSCRIPT });

  assert.equal(review.approved, true);
  assert.equal(review.reason, "Coerente");
  assert.equal(review.skipped, undefined);
}

async function testRejectsWhenModelRejects() {
  const service = createCaptionReviewService({
    logger: createSilentLogger(),
    aiProviderAdapter: createAdapter(async () => '{"approved":false,"reason":"Fala de outro assunto"}'),
  });

  await assert.rejects(
    () => service.assertCaptionApproved({ caption: CAPTION, transcript: TRANSCRIPT }),
    /Legenda reprovada: Fala de outro assunto/
  );
}

// Regressao do bug reportado: a legenda e a transcricao estavam prontas, mas o
// envio falhava porque a cascata de modelos do agente de revisao estava sem cota /
// com modelos retirados. Indisponibilidade do provedor nao e reprovacao de
// conteudo: o envio precisa seguir, com aviso no log.
async function testFailsOpenWhenAllModelsAreUnavailable() {
  const warnings = [];
  const service = createCaptionReviewService({
    logger: { info() {}, warn: (message) => warnings.push(message) },
    aiProviderAdapter: createAdapter(async () => {
      throw new SkippableModelError(
        "Falha ao gerar texto com Gemini (modelo gemini-2.5-flash-lite): This model models/gemini-2.5-flash-lite is no longer available to new users.",
        { retired: true }
      );
    }),
  });

  const review = await service.reviewCaption({ caption: CAPTION, transcript: TRANSCRIPT });

  assert.equal(review.approved, true);
  assert.equal(review.skipped, true);
  assert.match(review.reason, /Revisao factual indisponivel/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /caption_review\.skipped_provider_unavailable/);

  // assertCaptionApproved tambem deve deixar passar, senao o dispatch continua falhando.
  const asserted = await service.assertCaptionApproved({ caption: CAPTION, transcript: TRANSCRIPT });

  assert.equal(asserted.approved, true);
}

async function testFailsOpenWhenEveryModelWasExhausted() {
  const service = createCaptionReviewService({
    logger: createSilentLogger(),
    aiProviderAdapter: createAdapter(async () => {
      throw new Error("Nenhum modelo Gemini disponivel para gerar texto (tentados: a, b).");
    }),
  });

  const review = await service.reviewCaption({ caption: CAPTION, transcript: TRANSCRIPT });

  assert.equal(review.approved, true);
  assert.equal(review.skipped, true);
}

// Erro que nao e indisponibilidade do provedor continua estourando: nao queremos
// engolir bug de codigo e mandar legenda sem revisao por causa disso.
async function testUnexpectedErrorStillPropagates() {
  const service = createCaptionReviewService({
    logger: createSilentLogger(),
    aiProviderAdapter: createAdapter(async () => {
      throw new TypeError("adapter.reviewCaptionConsistency is not a function");
    }),
  });

  await assert.rejects(
    () => service.reviewCaption({ caption: CAPTION, transcript: TRANSCRIPT }),
    /is not a function/
  );
}

async function testStrictModeRestoresHardFailure() {
  const service = createCaptionReviewService({
    logger: createSilentLogger(),
    aiProviderAdapter: createAdapter(async () => {
      throw new SkippableModelError("Falha ao gerar texto com Gemini (modelo x): quota exceeded");
    }),
  });

  await assert.rejects(
    () => service.reviewCaption({ caption: CAPTION, transcript: TRANSCRIPT, strict: true }),
    /quota exceeded/
  );

  const previous = process.env.CAPTION_REVIEW_STRICT;
  process.env.CAPTION_REVIEW_STRICT = "true";

  try {
    await assert.rejects(
      () => service.reviewCaption({ caption: CAPTION, transcript: TRANSCRIPT }),
      /quota exceeded/
    );
  } finally {
    if (previous === undefined) {
      delete process.env.CAPTION_REVIEW_STRICT;
    } else {
      process.env.CAPTION_REVIEW_STRICT = previous;
    }
  }
}

// Legenda ou transcricao ausente continua sendo reprovacao de conteudo, nao
// indisponibilidade: nada de fail-open aqui.
async function testMissingTranscriptStillRejects() {
  const service = createCaptionReviewService({
    logger: createSilentLogger(),
    aiProviderAdapter: createAdapter(async () => {
      throw new Error("nao deveria chamar a IA sem transcricao");
    }),
  });

  const review = await service.reviewCaption({ caption: CAPTION, transcript: "" });

  assert.equal(review.approved, false);
  assert.equal(review.reason, "Transcricao do video ausente");
}

async function main() {
  await testApprovesWhenModelApproves();
  await testRejectsWhenModelRejects();
  await testFailsOpenWhenAllModelsAreUnavailable();
  await testFailsOpenWhenEveryModelWasExhausted();
  await testUnexpectedErrorStillPropagates();
  await testStrictModeRestoresHardFailure();
  await testMissingTranscriptStillRejects();

  console.log("caption-review-service tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
