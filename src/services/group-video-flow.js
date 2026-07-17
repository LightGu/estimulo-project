const APPROVED_VIDEO_STATUS = true;
const END_OF_QUEUE_PAUSE_REASON = "end_of_queue";

function normalizeText(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function normalizeComparableText(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeVideoId(value) {
  return normalizeText(value);
}

function resolveGroupId(group = {}) {
  return group.id || group.group_id || group.groupId;
}

function resolveDispatchGroupId(group = {}) {
  return group.evolution_group_id || group.group_id || group.groupId || group.id;
}

function resolveGroupTrail(group = {}) {
  return group.trilha_override || group.trilhaOverride || group.trilha_segmento || group.segmento;
}

function resolveVideoId(video = {}) {
  return video.id || video.video_id || video.videoId;
}

function resolveVideoEtapa(video = {}) {
  const etapa = Number(video.etapa);

  return Number.isFinite(etapa) ? etapa : Number.MAX_SAFE_INTEGER;
}

function resolveVideoApprovalDate(video = {}) {
  const rawDate = video.data_aprovacao || video.approved_at || video.approvedAt;
  const date = rawDate ? new Date(rawDate).getTime() : 0;

  return Number.isFinite(date) ? date : 0;
}

function isApprovedVideo(video = {}) {
  if (typeof video.status === "boolean") {
    return video.status === APPROVED_VIDEO_STATUS;
  }

  return ["true", "1", "sim", "aprovado"].includes(normalizeComparableText(video.status));
}

function isVideoForTrail(video = {}, trail) {
  return normalizeComparableText(video.trilha_segmento || video.trilhaSegmento) === normalizeComparableText(trail);
}

function isGroupPausedByEndOfQueue(group = {}) {
  const pauseReason =
    group.video_flow_pause_reason ||
    group.videoFlowPauseReason ||
    group.pause_reason ||
    group.pauseReason ||
    group.paused_reason ||
    group.pausedReason;

  return normalizeComparableText(pauseReason) === END_OF_QUEUE_PAUSE_REASON;
}

function canEvaluateGroupVideoFlow(group = {}) {
  return group.envia_video !== false;
}

function selectNextApprovedUnsentVideo(params = {}) {
  const group = params.group || {};
  const trail = resolveGroupTrail(group);

  if (!trail) {
    return undefined;
  }

  const sentVideoIds = new Set((params.sentVideoIds || []).map(normalizeVideoId).filter(Boolean));

  return (params.videos || [])
    .filter((video) => isApprovedVideo(video))
    .filter((video) => isVideoForTrail(video, trail))
    .filter((video) => !sentVideoIds.has(normalizeVideoId(resolveVideoId(video))))
    .sort((left, right) => {
      const etapaDifference = resolveVideoEtapa(left) - resolveVideoEtapa(right);

      if (etapaDifference !== 0) {
        return etapaDifference;
      }

      return resolveVideoApprovalDate(left) - resolveVideoApprovalDate(right);
    })[0];
}

async function findNextApprovedUnsentVideo(params = {}) {
  const { group, repository } = params;
  const groupId = resolveGroupId(group);
  const sentVideoIdsByGroup = params.sentVideoIdsByGroup || params.sent_video_ids_by_group;
  const sentVideoIds =
    sentVideoIdsByGroup && groupId
      ? sentVideoIdsByGroup[groupId] || sentVideoIdsByGroup[resolveDispatchGroupId(group)]
      : undefined;

  if (repository && typeof repository.findNextApprovedUnsentVideoForGroup === "function") {
    return repository.findNextApprovedUnsentVideoForGroup(group);
  }

  if (repository && typeof repository.findNextEligibleVideoForGroup === "function") {
    return repository.findNextEligibleVideoForGroup(group);
  }

  return selectNextApprovedUnsentVideo({
    ...params,
    sentVideoIds: sentVideoIds || params.sentVideoIds,
  });
}

function buildEndOfQueueLogPayload(params = {}) {
  const group = params.group || {};

  return {
    event: "group_video_flow.paused_end_of_queue",
    campaign_id: params.campaignId || params.campaign_id,
    group_id: resolveGroupId(group),
    dispatch_group_id: resolveDispatchGroupId(group),
    trilha_segmento: resolveGroupTrail(group),
    pause_reason: END_OF_QUEUE_PAUSE_REASON,
    paused_at: params.pausedAt,
  };
}

async function pauseGroupForEndOfQueue(params = {}) {
  const { group, repository, logger = console } = params;
  const pausedAt = params.pausedAt || new Date().toISOString();

  if (repository && typeof repository.pauseGroupVideoFlowForEndOfQueue === "function") {
    await repository.pauseGroupVideoFlowForEndOfQueue(resolveGroupId(group), {
      campaign_id: params.campaignId || params.campaign_id,
      reason: END_OF_QUEUE_PAUSE_REASON,
      paused_at: pausedAt,
      trilha_segmento: resolveGroupTrail(group),
    });
  } else if (repository && typeof repository.pauseGroupVideoFlow === "function") {
    await repository.pauseGroupVideoFlow(resolveGroupId(group), {
      campaign_id: params.campaignId || params.campaign_id,
      reason: END_OF_QUEUE_PAUSE_REASON,
      paused_at: pausedAt,
      trilha_segmento: resolveGroupTrail(group),
    });
  }

  if (!isGroupPausedByEndOfQueue(group) && logger && typeof logger.info === "function") {
    logger.info(JSON.stringify(buildEndOfQueueLogPayload({ ...params, group, pausedAt })));
  }
}

async function resumeGroupVideoFlow(params = {}) {
  const { group, repository } = params;

  if (!isGroupPausedByEndOfQueue(group) || !repository) {
    return;
  }

  if (typeof repository.resumeGroupVideoFlow === "function") {
    await repository.resumeGroupVideoFlow(resolveGroupId(group), {
      campaign_id: params.campaignId || params.campaign_id,
      reason: END_OF_QUEUE_PAUSE_REASON,
      resumed_at: params.resumedAt || new Date().toISOString(),
    });
  } else if (typeof repository.clearGroupVideoFlowPause === "function") {
    await repository.clearGroupVideoFlowPause(resolveGroupId(group), {
      campaign_id: params.campaignId || params.campaign_id,
      reason: END_OF_QUEUE_PAUSE_REASON,
      resumed_at: params.resumedAt || new Date().toISOString(),
    });
  }
}

async function resolveGroupVideoFlow(params = {}) {
  const group = params.group;

  if (!group) {
    throw new Error("group e obrigatorio para resolver fluxo de videos");
  }

  if (!canEvaluateGroupVideoFlow(group)) {
    return {
      status: "skipped",
      reason: "group_video_disabled",
      group,
    };
  }

  const video = await findNextApprovedUnsentVideo(params);

  if (!video) {
    await pauseGroupForEndOfQueue(params);

    return {
      status: "paused",
      reason: END_OF_QUEUE_PAUSE_REASON,
      group,
    };
  }

  await resumeGroupVideoFlow(params);

  return {
    status: "eligible",
    group,
    progress_group_id: resolveGroupId(group),
    group_id: resolveDispatchGroupId(group),
    video_catalog: video,
    video_id: resolveVideoId(video),
    drive_file_id: video.drive_file_id || video.driveFileId,
    legenda: params.legenda || video.legenda || video.caption,
  };
}

async function resolveGroupsVideoFlow(params = {}) {
  if (!Array.isArray(params.groups)) {
    throw new Error("groups deve ser uma lista para resolver fluxo de videos");
  }

  const results = [];

  for (const group of params.groups) {
    results.push(await resolveGroupVideoFlow({ ...params, group }));
  }

  return {
    results,
    dispatchGroups: results.filter((result) => result.status === "eligible"),
    pausedGroups: results.filter((result) => result.status === "paused"),
    skippedGroups: results.filter((result) => result.status === "skipped"),
  };
}

module.exports = {
  APPROVED_VIDEO_STATUS,
  END_OF_QUEUE_PAUSE_REASON,
  buildEndOfQueueLogPayload,
  canEvaluateGroupVideoFlow,
  isGroupPausedByEndOfQueue,
  resolveGroupTrail,
  resolveGroupVideoFlow,
  resolveGroupsVideoFlow,
  selectNextApprovedUnsentVideo,
};
