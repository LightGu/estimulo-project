const { createAIProviderAdapter } = require("./ai");

class CaptionReviewRejectedError extends Error {
  constructor(message, review = {}) {
    super(message);
    this.name = "CaptionReviewRejectedError";
    this.code = "CAPTION_REVIEW_REJECTED";
    this.review = review;
  }
}

function extractJsonObject(value) {
  const text = String(value || "").trim();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    const match = text.match(/\{[\s\S]*\}/);

    if (!match) {
      return null;
    }

    try {
      return JSON.parse(match[0]);
    } catch (_ignoredError) {
      return null;
    }
  }
}

function normalizeReviewResult(value) {
  if (typeof value === "boolean") {
    return {
      approved: value,
      reason: value ? "Legenda aprovada" : "Legenda reprovada",
    };
  }

  const parsed = typeof value === "string" ? extractJsonObject(value) : value;

  return {
    approved: parsed?.approved === true || String(parsed?.status || "").toLowerCase() === "approved",
    reason: String(parsed?.reason || parsed?.motivo || "").trim(),
  };
}

function assertReviewInput(caption, transcript) {
  if (!String(caption || "").trim()) {
    return {
      approved: false,
      reason: "Legenda vazia",
    };
  }

  if (!String(transcript || "").trim()) {
    return {
      approved: false,
      reason: "Transcricao do video ausente",
    };
  }

  return null;
}

function createCaptionReviewService(dependencies = {}) {
  const configuredAIOptions = {
    ...(dependencies.ai || {}),
    gemini: dependencies.gemini,
    openai: dependencies.openai,
  };
  const logger = dependencies.logger || console;

  function getAIProviderAdapter() {
    return dependencies.aiProviderAdapter || createAIProviderAdapter(configuredAIOptions);
  }

  async function reviewCaption(params = {}) {
    const caption = String(params.caption || "").trim();
    const transcript = String(params.transcript || "").trim();
    const inputError = assertReviewInput(caption, transcript);
    let review;

    if (inputError) {
      review = inputError;
    } else {
      const adapter = params.aiProviderAdapter || getAIProviderAdapter();

      if (!adapter || typeof adapter.reviewCaptionConsistency !== "function") {
        throw new Error("AIProviderAdapter invalido: reviewCaptionConsistency e obrigatorio");
      }

      review = normalizeReviewResult(
        await adapter.reviewCaptionConsistency(
          {
            caption,
            transcript,
          },
          params.ai || {}
        )
      );
    }

    logger.info &&
      logger.info(
        JSON.stringify({
          event: "caption_review.completed",
          approved: review.approved,
          reason: review.reason || null,
          campaign_id: params.campaign_id,
          group_id: params.group_id,
          progress_group_id: params.progress_group_id,
          video_id: params.video_id,
          caption_id: params.caption_id,
          generated: Boolean(params.generated),
        })
      );

    return {
      approved: Boolean(review.approved),
      reason: review.reason || (review.approved ? "Legenda aprovada" : "Legenda reprovada"),
    };
  }

  async function assertCaptionApproved(params = {}) {
    const review = await reviewCaption(params);

    if (!review.approved) {
      throw new CaptionReviewRejectedError(`Legenda reprovada: ${review.reason}`, review);
    }

    return review;
  }

  return {
    assertCaptionApproved,
    reviewCaption,
  };
}

module.exports = createCaptionReviewService();
module.exports.CaptionReviewRejectedError = CaptionReviewRejectedError;
module.exports.createCaptionReviewService = createCaptionReviewService;
module.exports.extractJsonObject = extractJsonObject;
module.exports.normalizeReviewResult = normalizeReviewResult;
