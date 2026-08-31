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
      findAll: async () => [{ id: "instance-1" }, { id: "instance-2" }, { id: "instance-3" }],
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
      groupLinksRepository: {
        listGroupIdsForInstance: async () => [],
        listGroupIdsForInstances: async () => [],
      },
      groupsRepository: { removeMany: async () => [] },
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

  // ---------- removeInstance: limpeza de grupos orfaos ----------
  // Unico numero cadastrado: nao sobra ninguem pra cobrir nada, entao todos os
  // grupos daquele numero saem do banco.
  {
    const removeManyCalls = [];
    const repository = {
      findById: async () => ({ id: "instance-1", instance_name: "estimulo-mvp" }),
      findAll: async () => [{ id: "instance-1" }],
      delete: async (id) => ({ id }),
      listActive: async () => [],
      reorderPriorities: async () => [],
    };

    const service = createWhatsappInstancesService({
      repository,
      groupLinksRepository: {
        listGroupIdsForInstance: async () => ["group-a", "group-b"],
        listGroupIdsForInstances: async () => {
          throw new Error("nao deveria ser chamado quando nao sobra instancia");
        },
      },
      groupsRepository: {
        removeMany: async (ids) => {
          removeManyCalls.push(ids);
          return ids.map((id) => ({ id }));
        },
      },
      deleteEvolutionInstance: async () => ({ status: 200, data: {} }),
    });

    const result = await service.removeInstance("instance-1");
    assert.deepEqual(removeManyCalls[0], ["group-a", "group-b"]);
    assert.deepEqual(result.removed_group_ids, ["group-a", "group-b"]);
    assert.equal(result.removed_groups_count, 2);
  }

  // Dois numeros: so os grupos exclusivos do removido saem; os comuns ficam para
  // o numero que permanece continuar disparando neles.
  {
    const removeManyCalls = [];
    let listedSurvivorIds;
    const repository = {
      findById: async () => ({ id: "instance-1", instance_name: "estimulo-mvp" }),
      findAll: async () => [{ id: "instance-1" }, { id: "instance-2" }],
      delete: async (id) => ({ id }),
      listActive: async () => [{ id: "instance-2" }],
      reorderPriorities: async () => [],
    };

    const service = createWhatsappInstancesService({
      repository,
      groupLinksRepository: {
        listGroupIdsForInstance: async () => ["group-comum", "group-so-do-removido"],
        listGroupIdsForInstances: async (ids) => {
          listedSurvivorIds = ids;
          return ["group-comum", "group-so-do-outro"];
        },
      },
      groupsRepository: {
        removeMany: async (ids) => {
          removeManyCalls.push(ids);
          return ids.map((id) => ({ id }));
        },
      },
      deleteEvolutionInstance: async () => ({ status: 200, data: {} }),
    });

    const result = await service.removeInstance("instance-1");
    assert.deepEqual(listedSurvivorIds, ["instance-2"]);
    assert.deepEqual(removeManyCalls[0], ["group-so-do-removido"]);
    assert.deepEqual(result.removed_group_ids, ["group-so-do-removido"]);
    assert.equal(result.removed_groups_count, 1);
  }

  // Instancia sem nenhum grupo vinculado: nada a apagar.
  {
    let removeManyCalled = false;
    const service = createWhatsappInstancesService({
      repository: {
        findById: async () => ({ id: "instance-1", instance_name: "estimulo-mvp" }),
        findAll: async () => [{ id: "instance-1" }, { id: "instance-2" }],
        delete: async (id) => ({ id }),
        listActive: async () => [{ id: "instance-2" }],
        reorderPriorities: async () => [],
      },
      groupLinksRepository: {
        listGroupIdsForInstance: async () => [],
        listGroupIdsForInstances: async () => [],
      },
      groupsRepository: {
        removeMany: async (ids) => {
          removeManyCalled = true;
          return ids.map((id) => ({ id }));
        },
      },
      deleteEvolutionInstance: async () => ({ status: 200, data: {} }),
    });

    const result = await service.removeInstance("instance-1");
    assert.deepEqual(result.removed_group_ids, []);
    assert.equal(result.removed_groups_count, 0);
    assert.equal(removeManyCalled, true, "removeMany e chamado com lista vazia (no-op no repositorio)");
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

  // ---------- pauseInstance / resumeInstance ----------
  {
    const updateCalls = [];
    let evolutionTouched = false;
    const repository = {
      findById: async () => ({ id: "instance-1", instance_name: "estimulo-mvp", paused_at: null }),
      update: async (id, payload) => {
        updateCalls.push({ id, payload });
        return { id, ...payload };
      },
    };

    const service = createWhatsappInstancesService({
      repository,
      deleteEvolutionInstance: async () => {
        evolutionTouched = true;
      },
      createEvolutionInstance: async () => {
        evolutionTouched = true;
      },
    });

    const paused = await service.pauseInstance("instance-1");
    assert.ok(paused.paused_at, "pausar grava o timestamp");

    const resumed = await service.resumeInstance("instance-1");
    assert.equal(resumed.paused_at, null, "despausar limpa o timestamp");

    assert.equal(evolutionTouched, false, "pausar nao mexe na Evolution API - a instancia segue conectada");
    assert.equal(updateCalls.length, 2);

    const notFoundService = createWhatsappInstancesService({ repository: { findById: async () => null } });
    await assert.rejects(() => notFoundService.pauseInstance("missing"), /Instance not found/);
  }

  // Numero pausado nao entra na checagem de cobertura: sem isso, todo grupo que
  // ele nao enxerga viraria falso "grupo dessincronizado" e bloquearia o disparo.
  {
    const repository = {
      listActive: async () => [{ id: "instance-1" }, { id: "instance-2" }],
      listDispatchable: async () => [{ id: "instance-1" }],
    };
    const groupLinksRepository = {
      listInstanceIdsByGroupIds: async () =>
        new Map([
          ["group-1", new Set(["instance-1", "instance-2"])],
          ["group-2", new Set(["instance-1"])],
        ]),
    };
    const service = createWhatsappInstancesService({ repository, groupLinksRepository });

    // Com instance-2 pausada sobra so uma instancia disparavel, entao nada e exigido.
    await service.assertGroupsDispatchable(["group-1", "group-2"]);
    const filtered = await service.filterDispatchableGroups(["group-1", "group-2"]);
    assert.deepEqual(filtered.eligible, ["group-1", "group-2"]);
    assert.deepEqual(filtered.ineligible, []);
  }

  // Tres numeros com um pausado: a cobertura passa a ser exigida apenas dos dois
  // que continuam disparando.
  {
    const repository = {
      listActive: async () => [{ id: "instance-1" }, { id: "instance-2" }, { id: "instance-3" }],
      listDispatchable: async () => [{ id: "instance-1" }, { id: "instance-2" }],
    };
    const groupLinksRepository = {
      listInstanceIdsByGroupIds: async () =>
        new Map([
          ["group-1", new Set(["instance-1", "instance-2"])],
          ["group-2", new Set(["instance-1", "instance-3"])],
        ]),
    };
    const service = createWhatsappInstancesService({ repository, groupLinksRepository });

    const filtered = await service.filterDispatchableGroups(["group-1", "group-2"]);
    assert.deepEqual(filtered.eligible, ["group-1"], "group-1 cobre os dois numeros ativos");
    assert.deepEqual(filtered.ineligible, ["group-2"], "group-2 so e visto por um ativo e pelo pausado");
  }

  // Fallback para repositorios/stubs sem listDispatchable: filtra paused_at em memoria.
  {
    const service = createWhatsappInstancesService({
      repository: {
        listActive: async () => [
          { id: "instance-1", paused_at: null },
          { id: "instance-2", paused_at: "2026-08-31T10:00:00.000Z" },
        ],
      },
    });

    const dispatchable = await service.listDispatchableInstances();
    assert.deepEqual(
      dispatchable.map((instance) => instance.id),
      ["instance-1"]
    );
  }

  // ---------- controller: PATCH /:id/pause ----------
  {
    const createController = require("../src/api/controllers/whatsapp-instances.controller");

    function createRes() {
      return {
        statusCode: null,
        body: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          this.body = payload;
          return this;
        },
      };
    }

    // paused precisa ser boolean explicito - sem isso um body vazio viraria
    // "despausar" silenciosamente.
    const validationController = createController({
      whatsappInstancesService: {
        setInstancePaused: async () => {
          throw new Error("nao deveria ser chamado com body invalido");
        },
      },
    });
    const invalidRes = createRes();
    await validationController.setPaused({ params: { id: "instance-1" }, body: {} }, invalidRes);
    assert.equal(invalidRes.statusCode, 400);

    const okController = createController({
      whatsappInstancesService: {
        setInstancePaused: async (id, paused) => ({ id, paused_at: paused ? "2026-08-31T10:00:00.000Z" : null }),
      },
    });
    const okRes = createRes();
    await okController.setPaused({ params: { id: "instance-1" }, body: { paused: true } }, okRes);
    assert.equal(okRes.statusCode, 200);
    assert.ok(okRes.body.paused_at);

    const notFoundController = createController({
      whatsappInstancesService: {
        setInstancePaused: async () => {
          throw new Error("Instance not found");
        },
      },
    });
    const notFoundRes = createRes();
    await notFoundController.setPaused({ params: { id: "missing" }, body: { paused: true } }, notFoundRes);
    assert.equal(notFoundRes.statusCode, 404);

    // Migration nao aplicada: 503 com instrucao, em vez de 500 opaco.
    const missingColumnController = createController({
      whatsappInstancesService: {
        setInstancePaused: async () => {
          const error = new Error('column "paused_at" of relation "whatsapp_instances" does not exist');
          error.code = "42703";
          throw error;
        },
      },
    });
    const missingColumnRes = createRes();
    await missingColumnController.setPaused({ params: { id: "instance-1" }, body: { paused: true } }, missingColumnRes);
    assert.equal(missingColumnRes.statusCode, 503);
    assert.match(missingColumnRes.body.error, /migration/i);
  }

  console.log("whatsapp instances service tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
