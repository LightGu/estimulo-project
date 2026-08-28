const assert = require("node:assert/strict");

const { createTrilhaSequenceService } = require("../src/services/trilha-sequence.service");

const PROFILES = [
  { id: "P1", nome: "Pré-infância", ordem: 1 },
  { id: "P2", nome: "Infância", ordem: 2 },
  { id: "P3", nome: "Adolescência", ordem: 3 },
  { id: "P4", nome: "Maturidade", ordem: 4 },
];

const SEQUENCE = {
  P1: [
    { trilha_id: "T1", profile_id: "P1", ordem: 1 },
    { trilha_id: "T2", profile_id: "P1", ordem: 2 },
    { trilha_id: "T3", profile_id: "P1", ordem: 3 },
  ],
  P2: [{ trilha_id: "T4", profile_id: "P2", ordem: 1 }],
  P3: [],
  P4: [{ trilha_id: "T5", profile_id: "P4", ordem: 1 }],
};

const TRILHAS = {
  T1: { id: "T1", macrotema: "M", trilha: "T1" },
  T2: { id: "T2", macrotema: "M", trilha: "T2" },
  T3: { id: "T3", macrotema: "M", trilha: "T3" },
  T4: { id: "T4", macrotema: "M", trilha: "T4" },
  T5: { id: "T5", macrotema: "M", trilha: "T5" },
  TD1: { id: "TD1", macrotema: "S", trilha: "Desvio bares" },
};

function buildRepositories({ desvios = [], deliveredTrilhaIds = [], hasReceived = () => false } = {}) {
  const trilhasRepository = {
    listTrilhaPerfisByProfile: async (profileId) => SEQUENCE[profileId] || [],
    findById: async (id) => TRILHAS[id] || null,
  };
  const trilhaDesviosRepository = {
    listByProfile: async (profileId) => desvios.filter((desvio) => desvio.profile_id === profileId),
    listAll: async () => desvios,
    findById: async (id) => desvios.find((desvio) => desvio.id === id) || null,
    create: async (payload) => ({ id: `desvio-${desvios.length + 1}`, created_at: new Date().toISOString(), ...payload }),
    remove: async (id) => desvios.find((desvio) => desvio.id === id) || null,
  };
  const groupProfilesRepository = {
    findAll: async () => PROFILES,
  };
  const groupVideoProgressRepository = {
    listDelivered: async () =>
      deliveredTrilhaIds.map((trilhaId) => ({ trilha_id: trilhaId, enviado_em: "2026-01-01T00:00:00.000Z" })),
    hasGroupReceivedTrilha: async (groupId, trilhaId) => hasReceived(trilhaId),
  };

  return { trilhasRepository, trilhaDesviosRepository, groupProfilesRepository, groupVideoProgressRepository };
}

function buildService(options) {
  return createTrilhaSequenceService(buildRepositories(options));
}

async function testFirstStepWhenNothingDelivered() {
  const service = buildService({});

  const next = await service.resolveNextTrilhaForGroup({ id: "g1", profile_id: "P1" });

  assert.deepEqual(next, { trilha_id: "T1", profile_id: "P1", checkpoint: false, reason: "sequencia" });
}

async function testAdvancesToNextSequenceStep() {
  const service = buildService({ deliveredTrilhaIds: ["T1"] });

  const next = await service.resolveNextTrilhaForGroup({ id: "g1", profile_id: "P1" });

  assert.deepEqual(next, { trilha_id: "T2", profile_id: "P1", checkpoint: false, reason: "sequencia" });
}

async function testReturnsNullWithoutProfileId() {
  const service = buildService({});

  const next = await service.resolveNextTrilhaForGroup({ id: "g1" });

  assert.equal(next, null);
}

async function testInitialDesvioReplacesFirstTrilhaForNewGroup() {
  const desvios = [
    { id: "d1", profile_id: "P1", after_trilha_id: null, setores: ["Bares e Restaurantes"], trilha_destino_id: "T3", created_at: "2026-01-01T00:00:00.000Z" },
  ];
  const service = buildService({ desvios, hasReceived: () => false });

  const next = await service.resolveNextTrilhaForGroup({ id: "g1", profile_id: "P1", setor: "Bares e Restaurantes" });

  assert.deepEqual(next, { trilha_id: "T3", profile_id: "P1", checkpoint: false, reason: "setor_desvio" });
}

async function testInitialDesvioIgnoredForGroupAlreadyInProgress() {
  const desvios = [
    { id: "d1", profile_id: "P1", after_trilha_id: null, setores: ["Bares e Restaurantes"], trilha_destino_id: "T3", created_at: "2026-01-01T00:00:00.000Z" },
  ];
  const service = buildService({ desvios, deliveredTrilhaIds: ["T1"] });

  const next = await service.resolveNextTrilhaForGroup({ id: "g1", profile_id: "P1", setor: "Bares e Restaurantes" });

  assert.deepEqual(next, { trilha_id: "T2", profile_id: "P1", checkpoint: false, reason: "sequencia" });
}

async function testSetorDesvioFiresOnFirstStepForNewGroup() {
  const desvios = [
    { id: "d1", profile_id: "P1", after_trilha_id: "T1", setores: ["Bares e Restaurantes"], trilha_destino_id: "TD1", created_at: "2026-01-01T00:00:00.000Z" },
  ];
  const service = buildService({ desvios, hasReceived: () => false });

  const next = await service.resolveNextTrilhaForGroup({ id: "g1", profile_id: "P1", setor: "Bares e Restaurantes" });

  assert.deepEqual(next, { trilha_id: "TD1", profile_id: "P1", checkpoint: false, reason: "setor_desvio" });
}

async function testSetorDesvioFiresWhenNotYetReceived() {
  const desvios = [
    { id: "d1", profile_id: "P1", after_trilha_id: "T2", setores: ["Bares e Restaurantes"], trilha_destino_id: "TD1", created_at: "2026-01-01T00:00:00.000Z" },
  ];
  const service = buildService({ desvios, deliveredTrilhaIds: ["T1", "T2"], hasReceived: () => false });

  const next = await service.resolveNextTrilhaForGroup({ id: "g1", profile_id: "P1", setor: "bares e restaurantes" });

  assert.deepEqual(next, { trilha_id: "TD1", profile_id: "P1", checkpoint: false, reason: "setor_desvio" });
}

async function testSetorDesvioSkippedWhenAlreadyReceived() {
  const desvios = [
    { id: "d1", profile_id: "P1", after_trilha_id: "T2", setores: ["Bares e Restaurantes"], trilha_destino_id: "TD1", created_at: "2026-01-01T00:00:00.000Z" },
  ];
  const service = buildService({ desvios, deliveredTrilhaIds: ["T1", "T2"], hasReceived: () => true });

  const next = await service.resolveNextTrilhaForGroup({ id: "g1", profile_id: "P1", setor: "Bares e Restaurantes" });

  assert.deepEqual(next, { trilha_id: "T3", profile_id: "P1", checkpoint: false, reason: "sequencia" });
}

async function testSetorDesvioIgnoredWhenSetorDoesNotMatch() {
  const desvios = [
    { id: "d1", profile_id: "P1", after_trilha_id: "T2", setores: ["Bares e Restaurantes"], trilha_destino_id: "TD1", created_at: "2026-01-01T00:00:00.000Z" },
  ];
  const service = buildService({ desvios, deliveredTrilhaIds: ["T1", "T2"] });

  const next = await service.resolveNextTrilhaForGroup({ id: "g1", profile_id: "P1", setor: "Comércio" });

  assert.deepEqual(next, { trilha_id: "T3", profile_id: "P1", checkpoint: false, reason: "sequencia" });
}

async function testNeverAdvancesToNextProfileAutomatically() {
  const service = buildService({ deliveredTrilhaIds: ["T1", "T2", "T3"] });

  const next = await service.resolveNextTrilhaForGroup({ id: "g1", profile_id: "P1" });

  assert.equal(next, null);
}

async function testEmptySequenceNeverHopsToAnotherProfile() {
  const service = buildService({ deliveredTrilhaIds: ["T4"] });

  const next = await service.resolveNextTrilhaForGroup({ id: "g1", profile_id: "P3" });

  assert.equal(next, null);
}

async function testJourneyCompleteReturnsNull() {
  const service = buildService({ deliveredTrilhaIds: ["T5"] });

  const next = await service.resolveNextTrilhaForGroup({ id: "g1", profile_id: "P4" });

  assert.equal(next, null);
}

async function testCursorAnchorsOnCurrentTrilhaIdNotDeliveryHistory() {
  // Grupo ja entregou ate a T3 (ultima trilha de P1) no passado, mas o operador
  // trocou manualmente a trilha atual de volta para T1 - a proxima deve ser a T2,
  // seguindo a trilha selecionada agora, nao o maior "ordem" ja entregue.
  const service = buildService({ deliveredTrilhaIds: ["T1", "T2", "T3"] });

  const next = await service.resolveNextTrilhaForGroup({ id: "g1", profile_id: "P1", trilha_id: "T1" });

  assert.deepEqual(next, { trilha_id: "T2", profile_id: "P1", checkpoint: false, reason: "sequencia" });
}

async function testExcludeTrilhaIdsSkipsEmptyTrilha() {
  const service = buildService({});

  const next = await service.resolveNextTrilhaForGroup(
    { id: "g1", profile_id: "P1" },
    { excludeTrilhaIds: new Set(["T1"]) }
  );

  assert.deepEqual(next, { trilha_id: "T2", profile_id: "P1", checkpoint: false, reason: "sequencia" });
}

async function testExcludeTrilhaIdsAppliesToDesvio() {
  const desvios = [
    { id: "d1", profile_id: "P1", after_trilha_id: "T2", setores: ["Bares e Restaurantes"], trilha_destino_id: "TD1", created_at: "2026-01-01T00:00:00.000Z" },
  ];
  const service = buildService({ desvios, deliveredTrilhaIds: ["T1", "T2"] });

  const next = await service.resolveNextTrilhaForGroup(
    { id: "g1", profile_id: "P1", setor: "Bares e Restaurantes" },
    { excludeTrilhaIds: new Set(["TD1"]) }
  );

  assert.deepEqual(next, { trilha_id: "T3", profile_id: "P1", checkpoint: false, reason: "sequencia" });
}

async function testMatchingDesvioTieBreaksByOldestCreatedAt() {
  const desvios = [
    { id: "d1", profile_id: "P1", after_trilha_id: "T2", setores: ["Bares e Restaurantes"], trilha_destino_id: "TD1", created_at: "2026-02-01T00:00:00.000Z" },
    { id: "d2", profile_id: "P1", after_trilha_id: "T2", setores: ["Bares e Restaurantes"], trilha_destino_id: "TD2", created_at: "2026-01-01T00:00:00.000Z" },
  ];
  const service = buildService({ desvios, deliveredTrilhaIds: ["T1", "T2"] });

  const next = await service.resolveNextTrilhaForGroup({ id: "g1", profile_id: "P1", setor: "Bares e Restaurantes" });

  assert.equal(next.trilha_id, "TD2");
}

async function testCountReachableSteps() {
  // So conta o que resta na sequencia do perfil atual (3 trilhas, cursor -1) mais
  // os desvios desse mesmo perfil - o motor nunca alcanca outro perfil sozinho.
  const desvios = [
    { id: "d1", profile_id: "P1", after_trilha_id: "T2", setores: ["Bares e Restaurantes"], trilha_destino_id: "TD1", created_at: "2026-01-01T00:00:00.000Z" },
  ];
  const service = buildService({ desvios });

  const total = await service.countReachableSteps({ id: "g1", profile_id: "P1" });

  assert.equal(total, 4);
}

async function testCountReachableStepsWithoutProfileIsZero() {
  const service = buildService({});

  const total = await service.countReachableSteps({ id: "g1" });

  assert.equal(total, 0);
}

async function testCreateDesvioValidations() {
  const service = buildService({});

  await assert.rejects(() => service.createDesvio({}), /Profile id is required/);
  await assert.rejects(
    () => service.createDesvio({ profile_id: "P1" }),
    /Trilha destino id is required/
  );
  await assert.rejects(
    () => service.createDesvio({ profile_id: "P1", after_trilha_id: "T2" }),
    /Trilha destino id is required/
  );
  await assert.rejects(
    () => service.createDesvio({ profile_id: "P1", after_trilha_id: "T2", trilha_destino_id: "TD1" }),
    /At least one setor is required/
  );
  await assert.rejects(
    () =>
      service.createDesvio({
        profile_id: "missing-profile",
        after_trilha_id: "T2",
        trilha_destino_id: "TD1",
        setores: ["Bares"],
      }),
    /Profile not found/
  );
  await assert.rejects(
    () =>
      service.createDesvio({
        profile_id: "P1",
        after_trilha_id: "missing-trilha",
        trilha_destino_id: "TD1",
        setores: ["Bares"],
      }),
    /After trilha not found/
  );
  await assert.rejects(
    () =>
      service.createDesvio({
        profile_id: "P1",
        after_trilha_id: "T2",
        trilha_destino_id: "missing-trilha",
        setores: ["Bares"],
      }),
    /Trilha destino not found/
  );
}

async function testCreateDesvioRejectsOverlappingSetorAtSameAnchor() {
  const desvios = [
    { id: "d1", profile_id: "P1", after_trilha_id: "T2", setores: ["Bares e Restaurantes"], trilha_destino_id: "TD1", created_at: "2026-01-01T00:00:00.000Z" },
  ];
  const service = buildService({ desvios });

  await assert.rejects(
    () =>
      service.createDesvio({
        profile_id: "P1",
        after_trilha_id: "T2",
        trilha_destino_id: "TD1",
        setores: ["bares e restaurantes"],
      }),
    /Setor already has a desvio at this point in the sequence/
  );
}

async function testCreateDesvioSucceedsWithoutOverlap() {
  const desvios = [
    { id: "d1", profile_id: "P1", after_trilha_id: "T2", setores: ["Bares e Restaurantes"], trilha_destino_id: "TD1", created_at: "2026-01-01T00:00:00.000Z" },
  ];
  const service = buildService({ desvios });

  const created = await service.createDesvio({
    profile_id: "P1",
    after_trilha_id: "T2",
    trilha_destino_id: "TD1",
    setores: ["Amazônia"],
  });

  assert.equal(created.profile_id, "P1");
  assert.deepEqual(created.setores, ["Amazônia"]);
}

async function testCreateDesvioAllowsInitialDesvioWithoutAfterTrilhaId() {
  const service = buildService({});

  const created = await service.createDesvio({
    profile_id: "P1",
    trilha_destino_id: "T3",
    setores: ["Bares e Restaurantes"],
  });

  assert.equal(created.profile_id, "P1");
  assert.equal(created.after_trilha_id, null);
  assert.equal(created.trilha_destino_id, "T3");
}

async function testCreateDesvioRejectsOverlappingInitialDesvio() {
  const desvios = [
    { id: "d1", profile_id: "P1", after_trilha_id: null, setores: ["Bares e Restaurantes"], trilha_destino_id: "T2", created_at: "2026-01-01T00:00:00.000Z" },
  ];
  const service = buildService({ desvios });

  await assert.rejects(
    () =>
      service.createDesvio({
        profile_id: "P1",
        trilha_destino_id: "T3",
        setores: ["bares e restaurantes"],
      }),
    /Setor already has a desvio at this point in the sequence/
  );
}

async function testRemoveDesvioNotFound() {
  const service = buildService({});

  await assert.rejects(() => service.removeDesvio("missing"), /Desvio not found/);
  await assert.rejects(() => service.removeDesvio(""), /Desvio id is required/);
}

async function testListDesviosByProfileRequiresId() {
  const service = buildService({});

  await assert.rejects(() => service.listDesviosByProfile(""), /Profile id is required/);
}

async function main() {
  await testFirstStepWhenNothingDelivered();
  await testAdvancesToNextSequenceStep();
  await testReturnsNullWithoutProfileId();
  await testInitialDesvioReplacesFirstTrilhaForNewGroup();
  await testInitialDesvioIgnoredForGroupAlreadyInProgress();
  await testSetorDesvioFiresOnFirstStepForNewGroup();
  await testSetorDesvioFiresWhenNotYetReceived();
  await testSetorDesvioSkippedWhenAlreadyReceived();
  await testSetorDesvioIgnoredWhenSetorDoesNotMatch();
  await testNeverAdvancesToNextProfileAutomatically();
  await testEmptySequenceNeverHopsToAnotherProfile();
  await testJourneyCompleteReturnsNull();
  await testCursorAnchorsOnCurrentTrilhaIdNotDeliveryHistory();
  await testExcludeTrilhaIdsSkipsEmptyTrilha();
  await testExcludeTrilhaIdsAppliesToDesvio();
  await testMatchingDesvioTieBreaksByOldestCreatedAt();
  await testCountReachableSteps();
  await testCountReachableStepsWithoutProfileIsZero();
  await testCreateDesvioValidations();
  await testCreateDesvioRejectsOverlappingSetorAtSameAnchor();
  await testCreateDesvioSucceedsWithoutOverlap();
  await testCreateDesvioAllowsInitialDesvioWithoutAfterTrilhaId();
  await testCreateDesvioRejectsOverlappingInitialDesvio();
  await testRemoveDesvioNotFound();
  await testListDesviosByProfileRequiresId();

  console.log("trilha-sequence-service tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
