const assert = require("node:assert/strict");

const whatsappInstancesRepository = require("../src/repositories/whatsapp-instances.repository");
const groupWhatsappInstancesRepository = require("../src/repositories/group-whatsapp-instances.repository");

function createMockClient(result) {
  const calls = [];
  const createBuilder = () => ({
    select() {
      return this;
    },
    insert(payload) {
      calls.push({ type: "insert", payload });
      return this;
    },
    update(payload) {
      calls.push({ type: "update", payload });
      return this;
    },
    upsert(payload, options) {
      calls.push({ type: "upsert", payload, options });
      return this;
    },
    delete() {
      calls.push({ type: "delete" });
      return this;
    },
    eq(column, value) {
      calls.push({ type: "eq", column, value });
      return this;
    },
    in(column, values) {
      calls.push({ type: "in", column, values });
      return Promise.resolve({ data: result, error: null });
    },
    not(column, operator, value) {
      calls.push({ type: "not", column, operator, value });
      return Promise.resolve({ data: result, error: null });
    },
    order(column, options) {
      calls.push({ type: "order", column, options });
      return Promise.resolve({ data: result, error: null });
    },
    maybeSingle() {
      return Promise.resolve({ data: result, error: null });
    },
    single() {
      return Promise.resolve({ data: result, error: null });
    },
  });

  const client = {
    from(tableName) {
      calls.push({ type: "from", tableName });
      return createBuilder();
    },
    __calls: calls,
  };

  return client;
}

async function main() {
  // ---------- whatsapp-instances.repository ----------
  {
    const client = createMockClient([
      { id: "instance-1", priority: 0 },
      { id: "instance-2", priority: 1 },
    ]);

    const instances = await whatsappInstancesRepository.listActive(client);
    assert.equal(instances.length, 2);
    assert.ok(client.__calls.some((call) => call.type === "from" && call.tableName === "whatsapp_instances"));
    assert.ok(client.__calls.some((call) => call.type === "eq" && call.column === "active" && call.value === true));
  }

  {
    const client = createMockClient({ id: "instance-1", instance_name: "estimulo-mvp" });
    const created = await whatsappInstancesRepository.create({ instance_name: "estimulo-mvp" }, client);
    assert.equal(created.instance_name, "estimulo-mvp");
    assert.ok(client.__calls.some((call) => call.type === "insert" && call.payload.instance_name === "estimulo-mvp"));
  }

  {
    const client = createMockClient([{ id: "instance-1" }]);
    await whatsappInstancesRepository.reorderPriorities(["instance-1", "instance-2"], client);

    const updateCalls = client.__calls.filter((call) => call.type === "update");
    assert.equal(updateCalls.length, 2);
    assert.equal(updateCalls[0].payload.priority, 0);
    assert.equal(updateCalls[1].payload.priority, 1);
  }

  // ---------- group-whatsapp-instances.repository ----------
  {
    const client = createMockClient({ group_id: "group-1", whatsapp_instance_id: "instance-1" });
    await groupWhatsappInstancesRepository.linkGroupToInstance("group-1", "instance-1", client);

    const upsertCall = client.__calls.find((call) => call.type === "upsert");
    assert.ok(upsertCall);
    assert.equal(upsertCall.payload.group_id, "group-1");
    assert.equal(upsertCall.payload.whatsapp_instance_id, "instance-1");
    assert.equal(upsertCall.options.onConflict, "group_id,whatsapp_instance_id");
  }

  {
    const client = createMockClient([
      { group_id: "group-1", whatsapp_instance_id: "instance-1" },
      { group_id: "group-1", whatsapp_instance_id: "instance-2" },
      { group_id: "group-2", whatsapp_instance_id: "instance-1" },
    ]);

    const map = await groupWhatsappInstancesRepository.listInstanceIdsByGroupIds(["group-1", "group-2"], client);
    assert.equal(map.get("group-1").size, 2);
    assert.ok(map.get("group-1").has("instance-1"));
    assert.ok(map.get("group-1").has("instance-2"));
    assert.equal(map.get("group-2").size, 1);
  }

  {
    const map = await groupWhatsappInstancesRepository.listInstanceIdsByGroupIds([]);
    assert.equal(map.size, 0);
  }

  console.log("whatsapp instances repository tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
