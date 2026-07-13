const DISPATCH_INITIAL_STATUS = "pending";
const TIME_ONLY_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

function normalizeScheduledDate(scheduledAt = new Date()) {
  const date = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);

  if (Number.isNaN(date.getTime())) {
    throw new Error("scheduled_at deve ser uma data valida");
  }

  return date;
}

function normalizeNumber(value, fieldName) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    throw new Error(`${fieldName} deve ser um numero valido`);
  }

  return number;
}

function normalizeJitterRange(params = {}) {
  const jitter = params.jitter || params.jitter_delay || params.delay_jitter || {};
  const minDelay =
    params.jitter_delay_min_ms ??
    params.jitterDelayMinMs ??
    params.min_delay_ms ??
    params.minDelayMs ??
    jitter.min_ms ??
    jitter.minDelayMs;
  const maxDelay =
    params.jitter_delay_max_ms ??
    params.jitterDelayMaxMs ??
    params.max_delay_ms ??
    params.maxDelayMs ??
    jitter.max_ms ??
    jitter.maxDelayMs;

  if (minDelay === undefined || maxDelay === undefined) {
    throw new Error("jitter_delay_min_ms e jitter_delay_max_ms sao obrigatorios");
  }

  const minMs = Math.trunc(normalizeNumber(minDelay, "jitter_delay_min_ms"));
  const maxMs = Math.trunc(normalizeNumber(maxDelay, "jitter_delay_max_ms"));

  if (minMs < 0 || maxMs < 0) {
    throw new Error("jitter_delay_min_ms e jitter_delay_max_ms devem ser maiores ou iguais a zero");
  }

  if (maxMs < minMs) {
    throw new Error("jitter_delay_max_ms deve ser maior ou igual a jitter_delay_min_ms");
  }

  return {
    min_ms: minMs,
    max_ms: maxMs,
  };
}

function normalizeTimePoint(value, baseDate, fieldName) {
  if (!value) {
    throw new Error(`${fieldName} e obrigatorio`);
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`${fieldName} deve ser uma data valida`);
    }

    return value;
  }

  const rawValue = String(value);
  const timeOnlyMatch = rawValue.match(TIME_ONLY_PATTERN);

  if (timeOnlyMatch) {
    const hours = Number(timeOnlyMatch[1]);
    const minutes = Number(timeOnlyMatch[2]);
    const seconds = Number(timeOnlyMatch[3] || 0);

    if (hours > 23 || minutes > 59 || seconds > 59) {
      throw new Error(`${fieldName} deve usar o formato HH:mm ou HH:mm:ss`);
    }

    const date = new Date(baseDate);
    date.setHours(hours, minutes, seconds, 0);
    return date;
  }

  return normalizeScheduledDate(rawValue);
}

function normalizeDispatchWindow(params = {}) {
  const timeWindow = params.time_window || params.timeWindow || {};
  const baseDate = normalizeScheduledDate(
    params.execution_at || params.executionAt || params.scheduled_at || params.scheduledAt || new Date()
  );
  const startValue = params.window_start || params.windowStart || timeWindow.start || timeWindow.start_at;
  const endValue = params.window_end || params.windowEnd || timeWindow.end || timeWindow.end_at;

  if (!startValue || !endValue) {
    throw new Error("window_start e window_end sao obrigatorios para calcular jitter");
  }

  const start = normalizeTimePoint(startValue, baseDate, "window_start");
  const end = normalizeTimePoint(endValue, baseDate, "window_end");

  if (end.getTime() <= start.getTime()) {
    end.setDate(end.getDate() + 1);
  }

  return {
    start,
    end,
  };
}

function normalizeDispatchGroups(groups) {
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error("groups deve conter ao menos um grupo");
  }

  return groups.map((group, index) => {
    if (typeof group === "string") {
      return {
        group_id: group,
        order: index + 1,
      };
    }

    if (!group || !group.group_id) {
      throw new Error("cada item de groups deve informar group_id");
    }

    return {
      ...group,
      order: group.order ?? index + 1,
    };
  });
}

function randomIntegerBetween(min, max, random = Math.random) {
  if (max <= min) {
    return min;
  }

  return min + Math.floor(random() * (max - min + 1));
}

function buildJitteredDispatchSchedule(params = {}) {
  const groups = normalizeDispatchGroups(params.groups);
  const jitter = normalizeJitterRange(params);
  const window = normalizeDispatchWindow(params);
  const random = params.random || Math.random;
  const effectiveMinDelay = groups.length > 1 ? Math.max(jitter.min_ms, 1) : jitter.min_ms;

  if (groups.length > 1 && jitter.max_ms < effectiveMinDelay) {
    throw new Error("jitter_delay_max_ms deve permitir horarios diferentes entre grupos");
  }

  const windowStart = window.start.getTime();
  const windowEnd = window.end.getTime();
  const minRequiredDelay = (groups.length - 1) * effectiveMinDelay;

  if (windowStart + minRequiredDelay > windowEnd) {
    throw new Error("janela da campanha nao comporta todos os grupos com o jitter minimo configurado");
  }

  let scheduledTime = windowStart;
  let cumulativeDelayMs = 0;

  return groups.map((group, index) => {
    let jitterDelayMs = 0;

    if (index > 0) {
      const groupsAfterCurrent = groups.length - index - 1;
      const remainingWindow = windowEnd - scheduledTime;
      const requiredForRest = groupsAfterCurrent * effectiveMinDelay;
      const maxAllowedDelay = Math.min(jitter.max_ms, remainingWindow - requiredForRest);

      if (maxAllowedDelay < effectiveMinDelay) {
        throw new Error("janela da campanha nao comporta todos os grupos com o jitter configurado");
      }

      jitterDelayMs = randomIntegerBetween(effectiveMinDelay, maxAllowedDelay, random);
      cumulativeDelayMs += jitterDelayMs;
      scheduledTime += jitterDelayMs;
    }

    return {
      group_id: group.group_id,
      campaign_id: group.campaign_id || params.campaign_id,
      link_video: group.link_video || params.link_video,
      legenda: group.legenda || params.legenda,
      scheduled_at: new Date(scheduledTime).toISOString(),
      status: group.status || params.status || DISPATCH_INITIAL_STATUS,
      dispatch_order: group.order,
      jitter_delay_ms: jitterDelayMs,
      cumulative_delay_ms: cumulativeDelayMs,
    };
  });
}

module.exports = {
  buildJitteredDispatchSchedule,
  normalizeDispatchWindow,
  normalizeJitterRange,
};
