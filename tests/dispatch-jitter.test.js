const assert = require("node:assert/strict");

const { buildJitteredDispatchSchedule } = require("../src/queues/dispatch-jitter");

function createBaseParams(overrides = {}) {
  return {
    campaign_id: "campaign-1",
    link_video: "https://example.com/video.mp4",
    legenda: "Legenda",
    execution_at: "2026-07-14T09:00:00.000Z",
    window_start: "09:00",
    window_end: "10:00",
    jitter_delay_min_ms: 1000,
    jitter_delay_max_ms: 1000,
    random: () => 0,
    ...overrides,
  };
}

async function testSkipsDisabledGroupsBeforeBuildingSchedule() {
  const schedule = buildJitteredDispatchSchedule(createBaseParams({
    groups: [
      { group_id: "group-1@g.us", envia_video: false },
      { group_id: "group-2@g.us", envia_video: true },
      { group_id: "group-3@g.us" },
    ],
  }));

  assert.equal(schedule.length, 2);
  assert.deepEqual(schedule.map((job) => job.group_id), ["group-2@g.us", "group-3@g.us"]);
  assert.equal(schedule[0].jitter_delay_ms, 1000);
  assert.equal(schedule[0].cumulative_delay_ms, 1000);
  assert.equal(new Date(schedule[1].scheduled_at).getTime() - new Date(schedule[0].scheduled_at).getTime(), 1000);
}

async function testReturnsEmptyScheduleWhenAllGroupsAreDisabled() {
  const schedule = buildJitteredDispatchSchedule(createBaseParams({
    groups: [
      { group_id: "group-1@g.us", envia_video: false },
      { group_id: "group-2@g.us", envia_video: false },
    ],
    window_start: undefined,
    window_end: undefined,
  }));

  assert.deepEqual(schedule, []);
}

async function main() {
  await testSkipsDisabledGroupsBeforeBuildingSchedule();
  await testReturnsEmptyScheduleWhenAllGroupsAreDisabled();

  console.log("dispatch-jitter tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
