const assert = require("node:assert/strict");

const { resolveDispatchSender } = require("../src/queues/dispatch");
const { sendToEvolution } = require("../src/services/evolution");

async function testFallsBackToDefaultSenderWhenNoInstanceId() {
  const sender = await resolveDispatchSender(undefined, {
    whatsappInstancesRepository: {
      findById: async () => {
        throw new Error("nao deveria ser chamado sem whatsapp_instance_id");
      },
    },
  });

  assert.equal(sender, sendToEvolution);
}

async function testResolvesInstanceScopedSenderWhenInstanceIdProvided() {
  const findByIdCalls = [];
  const sender = await resolveDispatchSender("instance-1", {
    whatsappInstancesRepository: {
      findById: async (id) => {
        findByIdCalls.push(id);
        return { id, instance_name: "estimulo-numero-2" };
      },
    },
  });

  assert.notEqual(sender, sendToEvolution);
  assert.equal(typeof sender, "function");
  assert.deepEqual(findByIdCalls, ["instance-1"]);
}

async function testFallsBackToDefaultSenderWhenInstanceMissing() {
  const sender = await resolveDispatchSender("missing-instance", {
    whatsappInstancesRepository: {
      findById: async () => null,
    },
  });

  assert.equal(sender, sendToEvolution);
}

async function main() {
  await testFallsBackToDefaultSenderWhenNoInstanceId();
  await testResolvesInstanceScopedSenderWhenInstanceIdProvided();
  await testFallsBackToDefaultSenderWhenInstanceMissing();

  console.log("dispatch instance sender resolution tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
