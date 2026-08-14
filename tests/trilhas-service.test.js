const assert = require("node:assert/strict");

const { createTrilhasService } = require("../src/services/trilhas.service");

function buildFixtures() {
  const trilhas = [{ id: "trilha-1", macrotema: "GESTÃO FINANCEIRA", trilha: "2.1 Fundamentos" }];
  const trilhaPerfis = [
    { id: "tp-1", trilha_id: "trilha-1", profile_id: "profile-infancia", perfil: "Infância", ordem: 1 },
  ];
  const videoLinks = [{ trilha_id: "trilha-1", video_id: "video-1", ordem: 1 }];
  const videos = [
    { id: "video-1", nome_do_arquivo: "aula-1.mp4", status: true },
    { id: "video-2", nome_do_arquivo: "aula-2.mp4", status: true },
  ];

  const repository = {
    findById: async (id) => trilhas.find((trilha) => trilha.id === id) || null,
    findByMacrotemaTrilha: async (macrotema, trilha) =>
      trilhas.find((item) => item.macrotema === macrotema && item.trilha === trilha) || null,
    create: async (payload) => {
      const created = { id: `trilha-${trilhas.length + 1}`, ...payload };
      trilhas.push(created);
      return created;
    },
    rename: async (id, payload) => {
      const trilha = trilhas.find((item) => item.id === id);
      Object.assign(trilha, payload);
      return trilha;
    },
    remove: async (id) => {
      const index = trilhas.findIndex((item) => item.id === id);
      const [removed] = trilhas.splice(index, 1);
      return removed || null;
    },
    setTrailPerfis: async (trilhaId, perfis) => {
      const remaining = trilhaPerfis.filter((row) => row.trilha_id !== trilhaId);
      trilhaPerfis.length = 0;
      trilhaPerfis.push(...remaining);
      perfis.forEach((perfil, index) => {
        trilhaPerfis.push({ id: `tp-${trilhaPerfis.length + 1}`, trilha_id: trilhaId, perfil, profile_id: null, ordem: index + 1 });
      });
      return trilhaPerfis.filter((row) => row.trilha_id === trilhaId);
    },
    addVideo: async (trilhaId, videoId, ordem) => {
      const link = { trilha_id: trilhaId, video_id: videoId, ordem };
      videoLinks.push(link);
      return link;
    },
    findVideoLink: async (trilhaId, videoId) =>
      videoLinks.find((link) => link.trilha_id === trilhaId && link.video_id === videoId) || null,
    listVideoLinksByTrilha: async (trilhaId) => videoLinks.filter((link) => link.trilha_id === trilhaId),
    listAllVideoLinks: async () => videoLinks,
    listAllTrailPerfis: async () => trilhaPerfis,
    listAll: async () => trilhas,
    listTrilhasByPerfil: async (perfil) =>
      trilhas.filter((trilha) => trilhaPerfis.some((row) => row.trilha_id === trilha.id && row.perfil === perfil)),
    listTrilhasByProfileId: async (profileId) =>
      trilhas.filter((trilha) => trilhaPerfis.some((row) => row.trilha_id === trilha.id && row.profile_id === profileId)),
    listTrilhaPerfisByProfile: async (profileId) =>
      trilhaPerfis
        .filter((row) => row.profile_id === profileId)
        .sort((left, right) => left.ordem - right.ordem),
    addTrilhaToProfileSequence: async (trilhaId, profileId, perfilNome) => {
      const existing = trilhaPerfis.filter((row) => row.profile_id === profileId);
      const maxOrdem = existing.reduce((max, row) => Math.max(max, Number(row.ordem) || 0), 0);
      const created = {
        id: `tp-${trilhaPerfis.length + 1}`,
        trilha_id: trilhaId,
        profile_id: profileId,
        perfil: perfilNome,
        ordem: maxOrdem + 1,
      };
      trilhaPerfis.push(created);
      return created;
    },
    reorderTrilhaPerfisForProfile: async (profileId, orderedTrilhaIds) => {
      orderedTrilhaIds.forEach((trilhaId, index) => {
        const row = trilhaPerfis.find((item) => item.trilha_id === trilhaId && item.profile_id === profileId);
        row.ordem = index + 1;
      });
      return trilhaPerfis.filter((row) => row.profile_id === profileId).sort((left, right) => left.ordem - right.ordem);
    },
    findFirstApprovedVideoByTrilhaAndProfile: async (trilhaId, profile) => {
      const hasPerfil = trilhaPerfis.some((row) => row.trilha_id === trilhaId && row.perfil === profile);

      if (!hasPerfil) {
        return null;
      }

      const links = videoLinks.filter((link) => link.trilha_id === trilhaId).sort((left, right) => left.ordem - right.ordem);
      const approvedLink = links.find((link) => videos.some((video) => video.id === link.video_id && video.status === true));

      if (!approvedLink) {
        return null;
      }

      return { ...videos.find((video) => video.id === approvedLink.video_id), ordem: approvedLink.ordem };
    },
  };

  const videoCatalogRepository = {
    findById: async (id) => videos.find((video) => video.id === id) || null,
    findAll: async () => videos,
  };

  const groupProfilesService = {
    list: async () => [
      { id: "profile-infancia", nome: "Infância" },
      { id: "profile-adolescencia", nome: "Adolescência" },
    ],
  };

  return { repository, videoCatalogRepository, groupProfilesService, trilhas, trilhaPerfis, videoLinks };
}

async function testCreateTrilhaBuildsOverviewAndValidates() {
  const { repository, videoCatalogRepository, groupProfilesService } = buildFixtures();
  const service = createTrilhasService({ repository, videoCatalogRepository, groupProfilesService });

  const created = await service.createTrilha({
    macrotema: "VENDAS",
    trilha: "3.1 Fundamentos",
    perfis: ["Infância"],
    video_ids: ["video-2"],
  });

  assert.equal(created.macrotema, "VENDAS");
  assert.equal(created.trilha, "3.1 Fundamentos");
  assert.deepEqual(created.perfis, ["Infância"]);
  assert.equal(created.videos.length, 1);
  assert.equal(created.videos[0].id, "video-2");

  await assert.rejects(
    () => service.createTrilha({ trilha: "X", perfis: ["Infância"], video_ids: ["video-2"] }),
    /Macrotema is required/
  );
  await assert.rejects(
    () => service.createTrilha({ macrotema: "X", perfis: ["Infância"], video_ids: ["video-2"] }),
    /Trilha is required/
  );
  await assert.rejects(
    () => service.createTrilha({ macrotema: "X", trilha: "Y", perfis: ["Infância"], video_ids: [] }),
    /At least one video_id is required/
  );
  await assert.rejects(
    () => service.createTrilha({ macrotema: "X", trilha: "Y", perfis: ["Perfil inexistente"], video_ids: ["video-2"] }),
    /Invalid perfil/
  );
  await assert.rejects(
    () =>
      service.createTrilha({
        macrotema: "GESTÃO FINANCEIRA",
        trilha: "2.1 Fundamentos",
        perfis: ["Infância"],
        video_ids: ["video-2"],
      }),
    /Trilha already exists/
  );
}

async function testUpdateTrailPerfisValidatesAndPersists() {
  const { repository, videoCatalogRepository, groupProfilesService, trilhaPerfis } = buildFixtures();
  const service = createTrilhasService({ repository, videoCatalogRepository, groupProfilesService });

  const result = await service.updateTrailPerfis("trilha-1", ["Adolescência"]);

  assert.deepEqual(result, ["Adolescência"]);
  assert.deepEqual(trilhaPerfis.map((row) => row.perfil), ["Adolescência"]);

  await assert.rejects(() => service.updateTrailPerfis("trilha-inexistente", ["Infância"]), /Trilha not found/);
  await assert.rejects(() => service.updateTrailPerfis("trilha-1", ["Perfil inexistente"]), /Invalid perfil/);
}

async function testListByPerfilReturnsSummary() {
  const { repository, videoCatalogRepository, groupProfilesService } = buildFixtures();
  const service = createTrilhasService({ repository, videoCatalogRepository, groupProfilesService });

  const list = await service.listByPerfil("Infância");

  assert.equal(list.length, 1);
  assert.equal(list[0].id, "trilha-1");
  assert.equal(list[0].videos_count, 1);
  assert.equal(list[0].first_video.id, "video-1");
}

async function testListByProfileIdRequiresIdAndReturnsSummary() {
  const { repository, videoCatalogRepository, groupProfilesService } = buildFixtures();
  const service = createTrilhasService({ repository, videoCatalogRepository, groupProfilesService });

  await assert.rejects(() => service.listByProfileId(""), /Profile id is required/);

  const list = await service.listByProfileId("profile-infancia");
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "trilha-1");
}

async function testGetFirstApprovedByProfileAndTrilha() {
  const { repository, videoCatalogRepository, groupProfilesService } = buildFixtures();
  const service = createTrilhasService({ repository, videoCatalogRepository, groupProfilesService });

  const video = await service.getFirstApprovedByProfileAndTrilha("Infância", "trilha-1");
  assert.equal(video.id, "video-1");

  await assert.rejects(() => service.getFirstApprovedByProfileAndTrilha("", "trilha-1"), /Profile is required/);
  await assert.rejects(
    () => service.getFirstApprovedByProfileAndTrilha("Infância", "trilha-inexistente"),
    /Trilha not found/
  );
}

async function testListSequenceForProfileReturnsOrderedDisplayData() {
  const { repository, videoCatalogRepository, groupProfilesService, trilhas, trilhaPerfis } = buildFixtures();
  trilhas.push({ id: "trilha-2", macrotema: "MARKETING", trilha: "4.1 Zero" });
  trilhaPerfis.push({ id: "tp-2", trilha_id: "trilha-2", profile_id: "profile-infancia", perfil: "Infância", ordem: 2 });
  const service = createTrilhasService({ repository, videoCatalogRepository, groupProfilesService });

  const sequence = await service.listSequenceForProfile("profile-infancia");

  assert.deepEqual(sequence.map((item) => item.trilha_id), ["trilha-1", "trilha-2"]);
  assert.equal(sequence[0].ordem, 1);
  assert.equal(sequence[0].videos_count, 1);
  assert.equal(sequence[0].approved_count, 1);
  assert.equal(sequence[1].videos_count, 0);

  await assert.rejects(() => service.listSequenceForProfile(""), /Profile id is required/);
}

async function testReorderSequenceForProfileValidatesAndPersists() {
  const { repository, videoCatalogRepository, groupProfilesService, trilhas, trilhaPerfis } = buildFixtures();
  trilhas.push({ id: "trilha-2", macrotema: "MARKETING", trilha: "4.1 Zero" });
  trilhaPerfis.push({ id: "tp-2", trilha_id: "trilha-2", profile_id: "profile-infancia", perfil: "Infância", ordem: 2 });
  const service = createTrilhasService({ repository, videoCatalogRepository, groupProfilesService });

  await service.reorderSequenceForProfile("profile-infancia", ["trilha-2", "trilha-1"]);

  const reordered = trilhaPerfis
    .filter((row) => row.profile_id === "profile-infancia")
    .sort((left, right) => left.ordem - right.ordem);
  assert.deepEqual(reordered.map((row) => row.trilha_id), ["trilha-2", "trilha-1"]);

  await assert.rejects(() => service.reorderSequenceForProfile("", ["trilha-1"]), /Profile id is required/);
  await assert.rejects(
    () => service.reorderSequenceForProfile("profile-infancia", []),
    /orderedTrilhaIds is required/
  );
  await assert.rejects(
    () => service.reorderSequenceForProfile("profile-infancia", ["trilha-inexistente", "trilha-1"]),
    /Trilha is not part of this profile's sequence/
  );
  await assert.rejects(
    () => service.reorderSequenceForProfile("profile-infancia", ["trilha-1"]),
    /orderedTrilhaIds must include every trilha currently in this profile's sequence/
  );
}

async function testAddTrilhaToSequenceAppendsAtEndByDefault() {
  const { repository, videoCatalogRepository, groupProfilesService, trilhas, trilhaPerfis } = buildFixtures();
  trilhas.push({ id: "trilha-2", macrotema: "MARKETING", trilha: "4.1 Zero" });
  const service = createTrilhasService({ repository, videoCatalogRepository, groupProfilesService });

  await service.addTrilhaToSequence("profile-infancia", "trilha-2");

  const sequence = trilhaPerfis
    .filter((row) => row.profile_id === "profile-infancia")
    .sort((left, right) => left.ordem - right.ordem);
  assert.deepEqual(sequence.map((row) => row.trilha_id), ["trilha-1", "trilha-2"]);
  assert.equal(sequence[1].perfil, "Infância");

  await assert.rejects(() => service.addTrilhaToSequence("", "trilha-2"), /Profile id is required/);
  await assert.rejects(() => service.addTrilhaToSequence("profile-infancia", "trilha-inexistente"), /Trilha not found/);
  await assert.rejects(
    () => service.addTrilhaToSequence("profile-inexistente", "trilha-2"),
    /Profile not found/
  );
  await assert.rejects(
    () => service.addTrilhaToSequence("profile-infancia", "trilha-1"),
    /Trilha already in this profile's sequence/
  );
}

async function testAddTrilhaToSequenceInsertsAfterAnchor() {
  const { repository, videoCatalogRepository, groupProfilesService, trilhas, trilhaPerfis } = buildFixtures();
  trilhas.push({ id: "trilha-2", macrotema: "MARKETING", trilha: "4.1 Zero" });
  trilhas.push({ id: "trilha-3", macrotema: "SAUDE", trilha: "5.1 Base" });
  trilhaPerfis.push({ id: "tp-2", trilha_id: "trilha-2", profile_id: "profile-infancia", perfil: "Infância", ordem: 2 });
  const service = createTrilhasService({ repository, videoCatalogRepository, groupProfilesService });

  await service.addTrilhaToSequence("profile-infancia", "trilha-3", "trilha-1");

  const sequence = trilhaPerfis
    .filter((row) => row.profile_id === "profile-infancia")
    .sort((left, right) => left.ordem - right.ordem);
  assert.deepEqual(sequence.map((row) => row.trilha_id), ["trilha-1", "trilha-3", "trilha-2"]);
}

async function main() {
  await testCreateTrilhaBuildsOverviewAndValidates();
  await testUpdateTrailPerfisValidatesAndPersists();
  await testListByPerfilReturnsSummary();
  await testListByProfileIdRequiresIdAndReturnsSummary();
  await testGetFirstApprovedByProfileAndTrilha();
  await testListSequenceForProfileReturnsOrderedDisplayData();
  await testReorderSequenceForProfileValidatesAndPersists();
  await testAddTrilhaToSequenceAppendsAtEndByDefault();
  await testAddTrilhaToSequenceInsertsAfterAnchor();

  console.log("trilhas-service tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
