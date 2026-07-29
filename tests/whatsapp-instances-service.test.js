const assert = require("node:assert/strict");

const { createWhatsappInstancesService } = require("../src/services/whatsapp-instances.service");

async function main() {
  // ---------- registerInstance ----------
  {
    const createCalls = [];
    const repository = {
      findByInstanceName: async () => null,
      findAll: async () => [{ id: "instance-1", priority: 0 }],
      create: async (payload) => {
        createCalls.push(payload);
        return { id: "instance-2", ...payload };
      },
    };

    const service = createWhatsappInstancesService({
      repository,
      createEvolutionInstance: async () => ({ status: 201, data: {} }),
    });

    const created = await service.registerInstance({ instance_name: "estimulo-numero-2" });
    assert.equal(created.instance_name, "estimulo-numero-2");
    assert.equal(createCalls[0].priority, 1);
    assert.equal(createCalls[0].connection_state, "pending");

    await assert.rejects(() => service.registerInstance({}), /instance_name is required/);
  }

  {
    const repository = {
      findByInstanceName: async () => ({ id: "instance-1" }),
    };
    const service = createWhatsappInstancesService({ repository });

    await assert.rejects(
      () => service.registerInstance({ instance_name: "estimulo-mvp" }),
      /Instance already exists/
    );
  }

  // ---------- testConnection ----------
  {
    const connectedService = createWhatsappInstancesService({
      listEvolutionInstances: async () => ({ status: 200, data: [] }),
    });

    const connectedResult = await connectedService.testConnection();
    assert.equal(connectedResult.connected, true);

    const failingService = createWhatsappInstancesService({
      listEvolutionInstances: async () => {
        throw new Error("Evolution indisponivel");
      },
    });

    const failingResult = await failingService.testConnection();
    assert.equal(failingResult.connected, false);
    assert.equal(failingResult.reason, "Evolution indisponivel");
  }

  // ---------- generateQrCode ----------
  {
    const updateCalls = [];
    const repository = {
      findById: async () => ({ id: "instance-1", instance_name: "estimulo-mvp" }),
      update: async (id, payload) => {
        updateCalls.push({ id, payload });
        return { id, ...payload };
      },
    };

    const service = createWhatsappInstancesService({
      repository,
      connectEvolutionInstance: async () => ({ data: { base64: "data:image/png;base64,abc123" } }),
    });

    const result = await service.generateQrCode("instance-1");
    assert.equal(result.qr_base64, "data:image/png;base64,abc123");
    assert.equal(result.expires_in_seconds, 45);
    assert.equal(updateCalls[0].payload.connection_state, "connecting");

    const notFoundService = createWhatsappInstancesService({
      repository: { findById: async () => null },
    });
    await assert.rejects(() => notFoundService.generateQrCode("missing"), /Instance not found/);
  }

  // ---------- checkConnectionStatus ----------
  {
    const repository = {
      findById: async () => ({ id: "instance-1", instance_name: "estimulo-mvp", connected_at: null }),
      update: async (id, payload) => ({ id, ...payload }),
    };

    const openService = createWhatsappInstancesService({
      repository,
      getEvolutionConnectionState: async () => ({ data: { instance: { state: "open" } } }),
      listEvolutionInstances: async () => ({ data: [{ ownerJid: "5511999999999@s.whatsapp.net" }] }),
    });
    const openResult = await openService.checkConnectionStatus("instance-1");
    assert.equal(openResult.connection_state, "open");
    assert.ok(openResult.connected_at);
    assert.equal(openResult.phone_number, "5511999999999");

    const unknownStateService = createWhatsappInstancesService({
      repository,
      getEvolutionConnectionState: async () => ({ data: { state: "weird-unrecognized-state" } }),
      listEvolutionInstances: async () => {
        throw new Error("nao deveria ser chamado quando o estado nao e open");
      },
    });
    const unknownResult = await unknownStateService.checkConnectionStatus("instance-1");
    assert.equal(unknownResult.connection_state, "close");
  }

  // ---------- removeInstance ----------
  {
    const deleteCalls = [];
    const reorderCalls = [];
    const repository = {
      findById: async () => ({ id: "instance-1", instance_name: "estimulo-mvp" }),
      delete: async (id) => {
        deleteCalls.push(id);
        return { id };
      },
      listActive: async () => [{ id: "instance-2" }, { id: "instance-3" }],
      reorderPriorities: async (ids) => {
        reorderCalls.push(ids);
        return [];
      },
    };
    let evolutionDeleteCalledWith;

    const service = createWhatsappInstancesService({
      repository,
      deleteEvolutionInstance: async (instanceName) => {
        evolutionDeleteCalledWith = instanceName;
        return { status: 200, data: {} };
      },
    });

    const result = await service.removeInstance("instance-1");
    assert.equal(result.removed, true);
    assert.equal(evolutionDeleteCalledWith, "estimulo-mvp");
    assert.deepEqual(deleteCalls, ["instance-1"]);
    assert.deepEqual(reorderCalls[0], ["instance-2", "instance-3"]);
  }

  // ---------- reorderPriority ----------
  {
    const service = createWhatsappInstancesService({
      repository: { reorderPriorities: async (ids) => ids },
    });

    await assert.rejects(() => service.reorderPriority([]), /orderedIds must be a non-empty array/);
    const result = await service.reorderPriority(["a", "b"]);
    assert.deepEqual(result, ["a", "b"]);
  }

  // ---------- getRotationSettings / updateRotationSettings ----------
  {
    const updateCalls = [];
    let storedSettings = { whatsapp_rotation_group_count: 3 };
    const settingsRepository = {
      getSettings: async () => storedSettings,
      updateSettings: async (payload) => {
        updateCalls.push(payload);
        storedSettings = { ...storedSettings, ...payload };
        return storedSettings;
      },
    };
    const service = createWhatsappInstancesService({ settingsRepository });

    const settings = await service.getRotationSettings();
    assert.equal(settings.whatsapp_rotation_group_count, 3);

    const updated = await service.updateRotationSettings({ whatsapp_rotation_group_count: 5 });
    assert.equal(updateCalls[0].whatsapp_rotation_group_count, 5);
    assert.equal(updated.whatsapp_rotation_group_count, 5);

    await assert.rejects(
      () => service.updateRotationSettings({ whatsapp_rotation_group_count: 0 }),
      /whatsapp_rotation_group_count must be an integer greater than or equal to 1/
    );
  }

  // ---------- assertGroupsDispatchable / filterDispatchableGroups ----------
  {
    // Apenas uma instancia ativa: nenhuma validacao deve ocorrer (comportamento atual preservado).
    const singleInstanceService = createWhatsappInstancesService({
      repository: { listActive: async () => [{ id: "instance-1" }] },
      groupLinksRepository: {
        listInstanceIdsByGroupIds: async () => {
          throw new Error("nao deveria ser chamado com uma unica instancia");
        },
      },
    });

    await singleInstanceService.assertGroupsDispatchable(["group-1"]);
    const singleResult = await singleInstanceService.filterDispatchableGroups(["group-1"]);
    assert.deepEqual(singleResult.eligible, ["group-1"]);
    assert.deepEqual(singleResult.ineligible, []);
  }

  {
    // Duas instancias ativas, grupo-1 vinculado a ambas, grupo-2 vinculado a apenas uma.
    const repository = { listActive: async () => [{ id: "instance-1" }, { id: "instance-2" }] };
    const groupLinksRepository = {
      listInstanceIdsByGroupIds: async () =>
        new Map([
          ["group-1", new Set(["instance-1", "instance-2"])],
          ["group-2", new Set(["instance-1"])],
        ]),
    };
    const service = createWhatsappInstancesService({ repository, groupLinksRepository });

    await service.assertGroupsDispatchable(["group-1"]);
    await assert.rejects(
      () => service.assertGroupsDispatchable(["group-1", "group-2"]),
      (error) => error.code === "GROUPS_MISSING_INSTANCE_COVERAGE" && error.groupIds.includes("group-2")
    );

    const filtered = await service.filterDispatchableGroups(["group-1", "group-2"]);
    assert.deepEqual(filtered.eligible, ["group-1"]);
    assert.deepEqual(filtered.ineligible, ["group-2"]);
  }

  console.log("whatsapp instances service tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
