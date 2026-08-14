const assert = require("node:assert/strict");

const {
  END_OF_QUEUE_PAUSE_REASON,
  resolveGroupVideoFlow,
  resolveGroupsVideoFlow,
  selectNextApprovedUnsentVideo,
} = require("../src/services/group-video-flow");

function createLogger() {
  const entries = [];

  return {
    entries,
    info(value) {
      entries.push(JSON.parse(value));
    },
  };
}

function createGroup(overrides = {}) {
  return {
    id: "group-1",
    evolution_group_id: "120363000000000000@g.us",
    segmento: "Pre infancia",
    trilha_id: "trilha-1",
    envia_video: true,
    ...overrides,
  };
}

function createVideo(overrides = {}) {
  return {
    id: "video-1",
    drive_file_id: "drive-file-1",
    etapa: 1,
    status: true,
    data_aprovacao: "2026-07-14T10:00:00.000Z",
    ...overrides,
  };
}

async function testSelectsFirstApprovedUnsentVideoForGroupTrail() {
  // Quem chama ja filtra params.videos para conter apenas os vinculos da trilha (via
  // trilha_videos), com ordem injetada a partir de trilha_videos.ordem.
  const video = selectNextApprovedUnsentVideo({
    group: createGroup(),
    sentVideoIds: ["video-1"],
    videos: [
      createVideo({ id: "video-1", ordem: 1, etapa: 1 }),
      createVideo({ id: "video-2", ordem: 2, etapa: 2, status: false }),
      createVideo({ id: "video-4", ordem: 4, etapa: 4 }),
      createVideo({ id: "video-5", ordem: 2, etapa: 2 }),
    ],
  });

  assert.equal(video.id, "video-5");
}

async function testPausesGroupWhenQueueEndsAndLogsTransition() {
  const logger = createLogger();
  const pauses = [];
  const trailFinishedCalls = [];
  const result = await resolveGroupVideoFlow({
    campaign_id: "campaign-1",
    group: createGroup(),
    sentVideoIds: ["video-1"],
    videos: [createVideo({ id: "video-1" })],
    logger,
    repository: {
      async pauseGroupVideoFlowForEndOfQueue(groupId, metadata) {
        pauses.push({ groupId, metadata });
      },
    },
    inAppNotificationsService: {
      async notifyTrailFinished(payload) {
        trailFinishedCalls.push(payload);
      },
    },
    pausedAt: "2026-07-14T12:00:00.000Z",
  });

  assert.equal(result.status, "paused");
  assert.equal(result.reason, END_OF_QUEUE_PAUSE_REASON);
  assert.equal(pauses.length, 1);
  assert.equal(pauses[0].groupId, "group-1");
  assert.equal(pauses[0].metadata.reason, END_OF_QUEUE_PAUSE_REASON);
  assert.equal(logger.entries.length, 1);
  assert.deepEqual(logger.entries[0], {
    event: "group_video_flow.paused_end_of_queue",
    campaign_id: "campaign-1",
    group_id: "group-1",
    dispatch_group_id: "120363000000000000@g.us",
    trilha_segmento: "Pre infancia",
    pause_reason: END_OF_QUEUE_PAUSE_REASON,
    paused_at: "2026-07-14T12:00:00.000Z",
  });
  assert.equal(trailFinishedCalls.length, 1);
  assert.deepEqual(trailFinishedCalls[0], {
    groupId: "group-1",
    groupName: undefined,
    trilhaLabel: "Pre infancia",
  });
}

async function testDoesNotRenotifyGroupAlreadyPausedByEndOfQueue() {
  const trailFinishedCalls = [];
  const result = await resolveGroupVideoFlow({
    campaign_id: "campaign-1",
    group: createGroup({ video_flow_pause_reason: END_OF_QUEUE_PAUSE_REASON }),
    sentVideoIds: ["video-1"],
    videos: [createVideo({ id: "video-1" })],
    repository: {
      async pauseGroupVideoFlowForEndOfQueue() {},
    },
    inAppNotificationsService: {
      async notifyTrailFinished(payload) {
        trailFinishedCalls.push(payload);
      },
    },
    pausedAt: "2026-07-14T12:00:00.000Z",
  });

  assert.equal(result.status, "paused");
  assert.equal(trailFinishedCalls.length, 0);
}

async function testSkipsDisabledGroupEvenWhenItWasAlreadyPausedByEndOfQueue() {
  const logger = createLogger();
  let repositoryCalled = false;
  const result = await resolveGroupVideoFlow({
    campaign_id: "campaign-1",
    group: createGroup({
      envia_video: false,
      video_flow_pause_reason: END_OF_QUEUE_PAUSE_REASON,
    }),
    sentVideoIds: ["video-1"],
    videos: [createVideo({ id: "video-1" })],
    logger,
    repository: {
      async findNextApprovedUnsentVideoForGroup() {
        repositoryCalled = true;
      },
    },
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "group_video_disabled");
  assert.equal(logger.entries.length, 0);
  assert.equal(repositoryCalled, false);
}

async function testDoesNotResumeDisabledPausedGroupWhenNewEligibleVideoExists() {
  const resumes = [];
  const result = await resolveGroupVideoFlow({
    campaign_id: "campaign-1",
    group: createGroup({
      envia_video: false,
      video_flow_pause_reason: END_OF_QUEUE_PAUSE_REASON,
    }),
    sentVideoIds: ["video-1"],
    videos: [
      createVideo({ id: "video-1", etapa: 1 }),
      createVideo({ id: "video-2", etapa: 2 }),
    ],
    repository: {
      async resumeGroupVideoFlow(groupId, metadata) {
        resumes.push({ groupId, metadata });
      },
    },
    resumedAt: "2026-07-14T13:00:00.000Z",
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "group_video_disabled");
  assert.equal(resumes.length, 0);
}

async function testSkipsManuallyDisabledGroup() {
  const result = await resolveGroupVideoFlow({
    group: createGroup({ envia_video: false }),
    sentVideoIds: [],
    videos: [createVideo()],
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "group_video_disabled");
}

async function testSelectsFirstApprovedUnsentVideoForGroupTrailId() {
  // Grupo ja migrado para o modelo relacional: quem chama ja filtra/decora os videos
  // pertencentes a trilha (via trilha_videos.ordem), a funcao pura so ordena/filtra
  // por aprovacao e ja-enviado (ver group-video-flow.js Fase 3).
  const video = selectNextApprovedUnsentVideo({
    group: createGroup({ trilha_id: "trilha-1", trilha_override: undefined, segmento: undefined }),
    sentVideoIds: ["video-1"],
    videos: [
      createVideo({ id: "video-1", ordem: 1 }),
      createVideo({ id: "video-2", ordem: 3, status: false }),
      createVideo({ id: "video-3", ordem: 2 }),
    ],
  });

  assert.equal(video.id, "video-3");
}

async function testResolvesGroupEligibleForDispatchByTrilhaId() {
  const result = await resolveGroupVideoFlow({
    campaign_id: "campaign-1",
    group: createGroup({ trilha_id: "trilha-1", trilha_override: undefined, segmento: undefined }),
    sentVideoIds: [],
    videos: [createVideo({ id: "video-1", ordem: 1 })],
  });

  assert.equal(result.status, "eligible");
  assert.equal(result.trilha_id, "trilha-1");
  assert.equal(result.video_id, "video-1");
}

async function testResolvesMultipleGroupsForDispatch() {
  const result = await resolveGroupsVideoFlow({
    campaign_id: "campaign-1",
    groups: [
      createGroup({ id: "group-1", evolution_group_id: "group-1@g.us" }),
      createGroup({ id: "group-2", evolution_group_id: "group-2@g.us", trilha_id: undefined }),
    ],
    sentVideoIds: [],
    videos: [createVideo({ id: "video-1", ordem: 1 })],
    logger: createLogger(),
    inAppNotificationsService: {
      async notifyTrailFinished() {},
    },
  });

  assert.equal(result.dispatchGroups.length, 1);
  assert.equal(result.dispatchGroups[0].group_id, "group-1@g.us");
  assert.equal(result.dispatchGroups[0].progress_group_id, "group-1");
  assert.equal(result.pausedGroups.length, 1);
  assert.equal(result.pausedGroups[0].group.id, "group-2");
}

async function testAutoAdvancesToNextTrilhaWhenEnabled() {
  const videosByTrilha = {
    "trilha-1": [],
    "trilha-2": [createVideo({ id: "video-2" })],
  };
  const updateCalls = [];
  const notifyCalls = [];
  const resolveCalls = [];

  const result = await resolveGroupVideoFlow({
    campaign_id: "campaign-1",
    group: createGroup({ trilha_id: "trilha-1", profile_id: "profile-1" }),
    dispatchRules: { auto_advance_trilha: true },
    repository: {
      async findNextApprovedUnsentVideoForGroup(group) {
        return (videosByTrilha[group.trilha_id] || [])[0];
      },
    },
    trilhaSequenceService: {
      async countReachableSteps() {
        return 5;
      },
      async resolveNextTrilhaForGroup(group, options) {
        resolveCalls.push({ trilha_id: group.trilha_id, excluded: [...(options?.excludeTrilhaIds || [])] });
        return { trilha_id: "trilha-2", profile_id: "profile-1", checkpoint: false, reason: "sequencia" };
      },
    },
    groupsRepository: {
      async updateTrilhaIfCurrent(groupId, expectedTrilhaId, payload) {
        updateCalls.push({ groupId, expectedTrilhaId, payload });
        return { ...createGroup({ trilha_id: "trilha-1", profile_id: "profile-1" }), ...payload };
      },
    },
    inAppNotificationsService: {
      async notifyTrailAdvanced(payload) {
        notifyCalls.push(payload);
      },
    },
  });

  assert.equal(result.status, "eligible");
  assert.equal(result.trilha_id, "trilha-2");
  assert.equal(result.video_id, "video-2");
  assert.equal(resolveCalls.length, 1);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].groupId, "group-1");
  assert.equal(updateCalls[0].expectedTrilhaId, "trilha-1");
  assert.equal(updateCalls[0].payload.trilha_id, "trilha-2");
  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0].reason, "sequencia");
}

async function testAutoAdvanceDisabledByDefaultFallsBackToPause() {
  let resolveCalled = false;

  const result = await resolveGroupVideoFlow({
    campaign_id: "campaign-1",
    group: createGroup({ trilha_id: "trilha-1", profile_id: "profile-1" }),
    repository: {
      async findNextApprovedUnsentVideoForGroup() {
        return undefined;
      },
    },
    trilhaSequenceService: {
      async resolveNextTrilhaForGroup() {
        resolveCalled = true;
        return null;
      },
    },
    inAppNotificationsService: {
      async notifyTrailFinished() {},
    },
  });

  assert.equal(result.status, "paused");
  assert.equal(resolveCalled, false);
}

async function testAutoAdvanceStopsOnLostRace() {
  let resolveCalls = 0;

  const result = await resolveGroupVideoFlow({
    campaign_id: "campaign-1",
    group: createGroup({ trilha_id: "trilha-1", profile_id: "profile-1" }),
    dispatchRules: { auto_advance_trilha: true },
    repository: {
      async findNextApprovedUnsentVideoForGroup() {
        return undefined;
      },
    },
    trilhaSequenceService: {
      async countReachableSteps() {
        return 5;
      },
      async resolveNextTrilhaForGroup() {
        resolveCalls += 1;
        return { trilha_id: "trilha-2", profile_id: "profile-1", checkpoint: false, reason: "sequencia" };
      },
    },
    groupsRepository: {
      async updateTrilhaIfCurrent() {
        // Corrida perdida: outro processo ja avancou o grupo, zero linhas afetadas.
        return null;
      },
    },
    inAppNotificationsService: {
      async notifyTrailFinished() {},
    },
  });

  assert.equal(result.status, "paused");
  assert.equal(resolveCalls, 1);
}

async function testAutoAdvanceSkipsEmptyTrilhaUntilVideoFound() {
  const videosByTrilha = {
    "trilha-1": [],
    "trilha-2": [],
    "trilha-3": [createVideo({ id: "video-3" })],
  };
  const resolveCalls = [];

  const result = await resolveGroupVideoFlow({
    campaign_id: "campaign-1",
    group: createGroup({ trilha_id: "trilha-1", profile_id: "profile-1" }),
    dispatchRules: { auto_advance_trilha: true },
    repository: {
      async findNextApprovedUnsentVideoForGroup(group) {
        return (videosByTrilha[group.trilha_id] || [])[0];
      },
    },
    trilhaSequenceService: {
      async countReachableSteps() {
        return 5;
      },
      async resolveNextTrilhaForGroup(group, options) {
        const excluded = [...(options?.excludeTrilhaIds || [])];
        resolveCalls.push(excluded);

        if (!excluded.includes("trilha-2")) {
          return { trilha_id: "trilha-2", profile_id: "profile-1", checkpoint: false, reason: "sequencia" };
        }

        return { trilha_id: "trilha-3", profile_id: "profile-1", checkpoint: false, reason: "sequencia" };
      },
    },
    groupsRepository: {
      async updateTrilhaIfCurrent(groupId, expectedTrilhaId, payload) {
        return { ...createGroup({ trilha_id: expectedTrilhaId, profile_id: "profile-1" }), ...payload };
      },
    },
    inAppNotificationsService: {
      async notifyTrailAdvanced() {},
    },
  });

  assert.equal(result.status, "eligible");
  assert.equal(result.trilha_id, "trilha-3");
  assert.equal(result.video_id, "video-3");
  assert.equal(resolveCalls.length, 2);
  assert.deepEqual(resolveCalls[0], []);
  assert.deepEqual(resolveCalls[1], ["trilha-2"]);
}

async function main() {
  await testSelectsFirstApprovedUnsentVideoForGroupTrail();
  await testPausesGroupWhenQueueEndsAndLogsTransition();
  await testDoesNotRenotifyGroupAlreadyPausedByEndOfQueue();
  await testSkipsDisabledGroupEvenWhenItWasAlreadyPausedByEndOfQueue();
  await testDoesNotResumeDisabledPausedGroupWhenNewEligibleVideoExists();
  await testSkipsManuallyDisabledGroup();
  await testSelectsFirstApprovedUnsentVideoForGroupTrailId();
  await testResolvesGroupEligibleForDispatchByTrilhaId();
  await testResolvesMultipleGroupsForDispatch();
  await testAutoAdvancesToNextTrilhaWhenEnabled();
  await testAutoAdvanceDisabledByDefaultFallsBackToPause();
  await testAutoAdvanceStopsOnLostRace();
  await testAutoAdvanceSkipsEmptyTrilhaUntilVideoFound();

  console.log("group-video-flow tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
