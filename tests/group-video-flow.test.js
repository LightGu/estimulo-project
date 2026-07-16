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
    envia_video: true,
    ...overrides,
  };
}

function createVideo(overrides = {}) {
  return {
    id: "video-1",
    drive_file_id: "drive-file-1",
    etapa: 1,
    trilha_segmento: "Pre infancia",
    status: "aprovado",
    data_aprovacao: "2026-07-14T10:00:00.000Z",
    ...overrides,
  };
}

async function testSelectsFirstApprovedUnsentVideoForGroupTrail() {
  const video = selectNextApprovedUnsentVideo({
    group: createGroup(),
    sentVideoIds: ["video-1"],
    videos: [
      createVideo({ id: "video-1", etapa: 1 }),
      createVideo({ id: "video-2", etapa: 2, status: "pendente_revisao" }),
      createVideo({ id: "video-3", etapa: 3, trilha_segmento: "Infancia" }),
      createVideo({ id: "video-4", etapa: 4 }),
      createVideo({ id: "video-5", etapa: 2 }),
    ],
  });

  assert.equal(video.id, "video-5");
}

async function testPausesGroupWhenQueueEndsAndLogsTransition() {
  const logger = createLogger();
  const pauses = [];
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

async function testResolvesMultipleGroupsForDispatch() {
  const result = await resolveGroupsVideoFlow({
    campaign_id: "campaign-1",
    groups: [
      createGroup({ id: "group-1", evolution_group_id: "group-1@g.us" }),
      createGroup({ id: "group-2", evolution_group_id: "group-2@g.us", segmento: "Infancia" }),
    ],
    sentVideoIds: [],
    videos: [createVideo({ id: "video-1", trilha_segmento: "Pre infancia" })],
    logger: createLogger(),
  });

  assert.equal(result.dispatchGroups.length, 1);
  assert.equal(result.dispatchGroups[0].group_id, "group-1@g.us");
  assert.equal(result.pausedGroups.length, 1);
  assert.equal(result.pausedGroups[0].group.id, "group-2");
}

async function main() {
  await testSelectsFirstApprovedUnsentVideoForGroupTrail();
  await testPausesGroupWhenQueueEndsAndLogsTransition();
  await testSkipsDisabledGroupEvenWhenItWasAlreadyPausedByEndOfQueue();
  await testDoesNotResumeDisabledPausedGroupWhenNewEligibleVideoExists();
  await testSkipsManuallyDisabledGroup();
  await testResolvesMultipleGroupsForDispatch();

  console.log("group-video-flow tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
