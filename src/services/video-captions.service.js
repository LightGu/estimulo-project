const videoCaptionsRepository = require("../repositories/video-captions.repository");

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

function createVideoCaptionsService(dependencies = {}) {
  const repository = dependencies.repository || videoCaptionsRepository;
  const timeZone = dependencies.timeZone || process.env.VIDEO_CAPTION_TIMEZONE || process.env.TZ || DEFAULT_CAPTION_TIMEZONE;

  async function selectCaptionForVideo(videoId, options = {}) {
    if (!videoId) {
      return null;
    }

    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    const todayStart = getStartOfTodayInTimeZone(now, options.timeZone || timeZone);
    const captions = await repository.listUnusedTodayByVideo(videoId, todayStart);
    const selected = captions.find((caption) => normalizeCaptionText(caption));

    if (!selected) {
      return null;
    }

    const usedAt = options.usedAt instanceof Date ? options.usedAt : now;
    const marked = await repository.markUsed(selected.id, usedAt);

    return {
      caption: marked || selected,
      text: normalizeCaptionText(marked || selected),
    };
  }

  return {
    selectCaptionForVideo,
  };
}

module.exports = createVideoCaptionsService();
module.exports.DEFAULT_CAPTION_TIMEZONE = DEFAULT_CAPTION_TIMEZONE;
module.exports.createVideoCaptionsService = createVideoCaptionsService;
module.exports.getStartOfTodayInTimeZone = getStartOfTodayInTimeZone;
module.exports.normalizeCaptionText = normalizeCaptionText;
