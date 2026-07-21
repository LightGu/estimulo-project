const videoCaptionsRepository = require("../repositories/video-captions.repository");
const { createAIProviderAdapter } = require("./ai");

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

function createVideoCaptionsService(dependencies = {}) {
  const repository = dependencies.repository || videoCaptionsRepository;
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
    const selected = captions.find((caption) => normalizeCaptionText(caption));
    const usedAt = options.usedAt instanceof Date ? options.usedAt : now;

    if (selected) {
      const marked = await repository.markUsed(selected.id, usedAt);

      return {
        caption: marked || selected,
        generated: false,
        text: normalizeCaptionText(marked || selected),
      };
    }

    if (!options.downloadedVideo) {
      return null;
    }

    const generatedText = String(
      await generateCaption(getAIProviderAdapter(), options.downloadedVideo, options.ai || {})
    ).trim();

    if (!generatedText) {
      return null;
    }

    const created = await repository.create({
      video_id: videoId,
      caption_text: generatedText,
      ultimo_uso_em: usedAt.toISOString(),
    });

    return {
      caption: created,
      generated: true,
      text: normalizeCaptionText(created) || generatedText,
    };
  }

  return {
    selectCaptionForVideo,
  };
}

module.exports = createVideoCaptionsService();
module.exports.DEFAULT_CAPTION_TIMEZONE = DEFAULT_CAPTION_TIMEZONE;
module.exports.createVideoCaptionsService = createVideoCaptionsService;
module.exports.generateCaption = generateCaption;
module.exports.getStartOfTodayInTimeZone = getStartOfTodayInTimeZone;
module.exports.normalizeCaptionText = normalizeCaptionText;
