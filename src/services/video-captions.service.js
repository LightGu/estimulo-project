const videoCaptionsRepository = require("../repositories/video-captions.repository");
const { createAIProviderAdapter } = require("./ai");
const defaultCaptionReviewService = require("./caption-review.service");

const DEFAULT_CAPTION_TIMEZONE = "America/Bahia";

function getTimeZoneDateParts(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  })
    .formatToParts(date)
    .reduce((parts, part) => {
      parts[part.type] = part.value;
      return parts;
    }, {});
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric",
  })
    .formatToParts(date)
    .reduce((accumulator, part) => {
      accumulator[part.type] = part.value;
      return accumulator;
    }, {});

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  return asUtc - date.getTime();
}

function getStartOfTodayInTimeZone(now = new Date(), timeZone = DEFAULT_CAPTION_TIMEZONE) {
  const parts = getTimeZoneDateParts(now, timeZone);
  const localMidnightAsUtc = new Date(
    Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 0, 0, 0, 0)
  );
  const offsetMs = getTimeZoneOffsetMs(localMidnightAsUtc, timeZone);

  return new Date(localMidnightAsUtc.getTime() - offsetMs);
}

function normalizeCaptionText(caption) {
  return String(caption?.caption_text || caption?.captionText || "").trim();
}

async function generateCaption(adapter, downloadedVideo, options = {}) {
  if (!downloadedVideo) {
    return "";
  }

  if (adapter && typeof adapter.generateCaption === "function") {
    return adapter.generateCaption(downloadedVideo, options);
  }

  if (adapter && typeof adapter.transcribe === "function") {
    return adapter.transcribe(downloadedVideo, options);
  }

  throw new Error("AIProviderAdapter invalido: generateCaption e obrigatorio");
}

async function generateCaptionFromTranscript(adapter, transcript, options = {}) {
  if (!String(transcript || "").trim()) {
    return "";
  }

  if (adapter && typeof adapter.generateCaptionFromTranscript === "function") {
    return adapter.generateCaptionFromTranscript(transcript, options);
  }

  throw new Error("AIProviderAdapter invalido: generateCaptionFromTranscript e obrigatorio");
}

function createVideoCaptionsService(dependencies = {}) {
  const repository = dependencies.repository || videoCaptionsRepository;
  const captionReviewService = dependencies.captionReviewService || defaultCaptionReviewService;
  const logger = dependencies.logger || console;
  const timeZone = dependencies.timeZone || process.env.VIDEO_CAPTION_TIMEZONE || process.env.TZ || DEFAULT_CAPTION_TIMEZONE;
  const configuredAIOptions = {
    ...(dependencies.ai || {}),
    gemini: dependencies.gemini,
    openai: dependencies.openai,
  };

  function getAIProviderAdapter() {
    return dependencies.aiProviderAdapter || createAIProviderAdapter(configuredAIOptions);
  }

  async function selectCaptionForVideo(videoId, options = {}) {
    if (!videoId) {
      return null;
    }

    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    const todayStart = getStartOfTodayInTimeZone(now, options.timeZone || timeZone);
    const captions = await repository.listUnusedTodayByVideo(videoId, todayStart);
    const shouldReviewCaption = Boolean(options.requireCaptionReview || options.transcript);
    const hasTranscriptOption = Object.prototype.hasOwnProperty.call(options, "transcript");
    let transcriptResolved = false;
    let resolvedTranscript;
    const reviewCaption = shouldReviewCaption
      ? typeof options.reviewCaption === "function"
        ? options.reviewCaption
        : captionReviewService && typeof captionReviewService.reviewCaption === "function"
          ? captionReviewService.reviewCaption
          : null
      : null;

    async function getTranscript() {
      if (!hasTranscriptOption) {
        return undefined;
      }

      if (!transcriptResolved) {
        resolvedTranscript = String(await Promise.resolve(options.transcript) || "").trim();
        transcriptResolved = true;
      }

      return resolvedTranscript;
    }

    async function approveCaption(captionRecord, generated) {
      const text = normalizeCaptionText(captionRecord);

      if (!text) {
        return null;
      }

      if (reviewCaption) {
        const transcript = await getTranscript();
        const review = await reviewCaption({
          caption: text,
          transcript,
          campaign_id: options.campaign_id,
          group_id: options.group_id,
          progress_group_id: options.progress_group_id,
          video_id: videoId,
          caption_id: captionRecord && captionRecord.id,
          generated,
          ai: options.reviewAi,
        });

        if (!review.approved) {
          logger.warn &&
            logger.warn(
              JSON.stringify({
                event: "caption_review.rejected",
                video_id: videoId,
                caption_id: captionRecord && captionRecord.id,
                generated: Boolean(generated),
                reason: review.reason,
              })
            );

          return null;
        }
      }

      if (captionRecord && captionRecord.id) {
        return {
          caption: captionRecord,
          generated: Boolean(generated),
          text,
        };
      }

      return {
        caption: captionRecord,
        generated: Boolean(generated),
        text,
      };
    }

    for (const selected of captions) {
      const approved = await approveCaption(selected, false);

      if (approved) {
        return approved;
      }
    }

    const hasDownloadedVideoOption = Object.prototype.hasOwnProperty.call(options, "downloadedVideo");
    const downloadedVideo = hasDownloadedVideoOption ? await Promise.resolve(options.downloadedVideo) : undefined;
    const transcript = await getTranscript();

    if (!downloadedVideo && !transcript) {
      return null;
    }

    const adapter = getAIProviderAdapter();
    const generatedText = String(
      transcript
        ? await generateCaptionFromTranscript(adapter, transcript, options.ai || {})
        : await generateCaption(adapter, downloadedVideo, options.ai || {})
    ).trim();

    if (!generatedText) {
      return null;
    }

    const generatedReview = await approveCaption({ caption_text: generatedText }, true);

    if (!generatedReview) {
      return null;
    }

    const created = await repository.create({
      video_id: videoId,
      caption_text: generatedText,
    });

    return {
      caption: created,
      generated: true,
      text: normalizeCaptionText(created) || generatedText,
    };
  }

  async function markCaptionUsed(captionId, options = {}) {
    if (!captionId || !repository || typeof repository.markUsed !== "function") {
      return null;
    }

    const usedAt = options.usedAt instanceof Date ? options.usedAt : new Date(options.usedAt || Date.now());

    return repository.markUsed(captionId, usedAt);
  }

  return {
    markCaptionUsed,
    selectCaptionForVideo,
  };
}

module.exports = createVideoCaptionsService();
module.exports.DEFAULT_CAPTION_TIMEZONE = DEFAULT_CAPTION_TIMEZONE;
module.exports.createVideoCaptionsService = createVideoCaptionsService;
module.exports.generateCaption = generateCaption;
module.exports.generateCaptionFromTranscript = generateCaptionFromTranscript;
module.exports.getStartOfTodayInTimeZone = getStartOfTodayInTimeZone;
module.exports.normalizeCaptionText = normalizeCaptionText;
