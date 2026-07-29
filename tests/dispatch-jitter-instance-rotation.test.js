const assert = require("node:assert/strict");

const { buildJitteredDispatchSchedule, resolveInstanceForOrder } = require("../src/queues/dispatch-jitter");

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

async function testResolveInstanceForOrderWrapsAcrossInstances() {
  const instances = [{ id: "instance-a" }, { id: "instance-b" }];

  // N=3: grupos 1-3 -> instancia A, 4-6 -> instancia B, 7-9 -> instancia A (repete o ciclo).
  assert.equal(resolveInstanceForOrder(1, instances, 3), "instance-a");
  assert.equal(resolveInstanceForOrder(3, instances, 3), "instance-a");
  assert.equal(resolveInstanceForOrder(4, instances, 3), "instance-b");
  assert.equal(resolveInstanceForOrder(6, instances, 3), "instance-b");
  assert.equal(resolveInstanceForOrder(7, instances, 3), "instance-a");
}

async function testResolveInstanceForOrderBackwardCompatibility() {
  // Sem instancias: nunca atribui um id (instalacao legada sem tabela populada).
  assert.equal(resolveInstanceForOrder(1, [], 3), null);
  assert.equal(resolveInstanceForOrder(1, undefined, 3), null);

  // Uma unica instancia: sempre a mesma, independente da ordem/N.
  const singleInstance = [{ id: "instance-only" }];
  assert.equal(resolveInstanceForOrder(1, singleInstance, 5), "instance-only");
  assert.equal(resolveInstanceForOrder(42, singleInstance, 1), "instance-only");
}

async function testBuildJitteredDispatchScheduleAttachesResolvedInstanceId() {
  const schedule = buildJitteredDispatchSchedule(createBaseParams({
    groups: [
      { group_id: "group-1@g.us" },
      { group_id: "group-2@g.us" },
      { group_id: "group-3@g.us" },
    ],
    whatsapp_instances: [{ id: "instance-a" }, { id: "instance-b" }],
    rotation_group_count: 2,
    window_end: "12:00",
  }));

  assert.equal(schedule[0].whatsapp_instance_id, "instance-a");
  assert.equal(schedule[1].whatsapp_instance_id, "instance-a");
  assert.equal(schedule[2].whatsapp_instance_id, "instance-b");
}

async function testBuildJitteredDispatchScheduleOmitsInstanceIdWhenNotProvided() {
  const schedule = buildJitteredDispatchSchedule(createBaseParams({
    groups: [{ group_id: "group-1@g.us" }, { group_id: "group-2@g.us" }],
  }));

  assert.equal(schedule[0].whatsapp_instance_id, null);
  assert.equal(schedule[1].whatsapp_instance_id, null);
}

async function main() {
  await testResolveInstanceForOrderWrapsAcrossInstances();
  await testResolveInstanceForOrderBackwardCompatibility();
  await testBuildJitteredDispatchScheduleAttachesResolvedInstanceId();
  await testBuildJitteredDispatchScheduleOmitsInstanceIdWhenNotProvided();

  console.log("dispatch-jitter instance rotation tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
