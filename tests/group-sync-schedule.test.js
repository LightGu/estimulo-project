const assert = require("node:assert/strict");

const {
  GROUP_SYNC_SCHEDULE_KEY,
  buildGroupSyncRepeatOptions,
  buildGroupSyncScheduleJobData,
} = require("../src/queues/group-sync-schedule");
const {
  GROUP_SYNC_PROCESSING_STATUS,
  GROUP_SYNC_SUCCESS_STATUS,
  buildGroupSyncJobData,
  createGroupSyncProcessor,
} = require("../src/queues/group-sync");

async function testBuildsRepeatOptionsFromParams() {
  const repeatOptions = buildGroupSyncRepeatOptions({
    cron_expression: "0 4 * * *",
    timezone: "America/Bahia",
  });

  assert.equal(repeatOptions.key, GROUP_SYNC_SCHEDULE_KEY);
  assert.equal(repeatOptions.pattern, "0 4 * * *");
  assert.equal(repeatOptions.tz, "America/Bahia");
}

async function testBuildsRecurringJobData() {
  const repeatOptions = buildGroupSyncRepeatOptions({
    cron_expression: "0 4 * * *",
    timezone: "America/Bahia",
  });
  const buildJobData = (params) => ({
    organization_id: params.organization_id,
    maturidade: params.maturidade,
    status: "pending",
  });
  const jobData = buildGroupSyncScheduleJobData(
    {
      organization_id: "org-1",
      maturidade: 2,
    },
    repeatOptions,
    buildJobData
  );

  assert.equal(jobData.organization_id, "org-1");
  assert.equal(jobData.maturidade, 2);
  assert.equal(jobData.schedule_key, GROUP_SYNC_SCHEDULE_KEY);
  assert.equal(jobData.trigger_type, "recurring");
  assert.deepEqual(jobData.recurrence, {
    pattern: "0 4 * * *",
    timezone: "America/Bahia",
  });
}

async function testBuildsGroupSyncJobData() {
  const jobData = buildGroupSyncJobData({
    organization_id: "org-1",
    maturidade: 3,
    requested_at: "2026-07-17T10:00:00.000Z",
  });

  assert.equal(jobData.organization_id, "org-1");
  assert.equal(jobData.maturidade, 3);
  assert.equal(jobData.status, "pending");
  assert.equal(jobData.requested_at, "2026-07-17T10:00:00.000Z");
}

async function testProcessorRunsGroupSyncService() {
  const updates = [];
  const calls = [];
  const processor = createGroupSyncProcessor({
    logger: {},
    service: {
      syncGroupsFromEvolution: async (params) => {
        calls.push(params);

        return {
          inserted: 1,
          updated: 2,
          ignored: 3,
          groups: [{ id: "120363@g.us", nome: "Grupo", quantidade_membros: 10 }],
        };
      },
    },
  });
  const job = {
    id: "job-1",
    data: {
      organization_id: "org-1",
      maturidade: 2,
    },
    updateData: async (data) => {
      updates.push(data);
      job.data = data;
    },
  };

  const result = await processor(job);

  assert.deepEqual(calls, [{ organization_id: "org-1", maturidade: 2 }]);
  assert.equal(updates[0].status, GROUP_SYNC_PROCESSING_STATUS);
  assert.equal(updates[1].status, GROUP_SYNC_SUCCESS_STATUS);
  assert.equal(updates[1].inserted, 1);
  assert.equal(updates[1].updated, 2);
  assert.equal(updates[1].ignored, 3);
  assert.equal(result.status, GROUP_SYNC_SUCCESS_STATUS);
  assert.equal(result.groups.length, 1);
}

async function main() {
  await testBuildsRepeatOptionsFromParams();
  await testBuildsRecurringJobData();
  await testBuildsGroupSyncJobData();
  await testProcessorRunsGroupSyncService();

  console.log("group-sync-schedule tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
