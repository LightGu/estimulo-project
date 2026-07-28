const assert = require("node:assert/strict");

const trilhasRepository = require("../src/repositories/trilhas.repository");

function createMockClient({ perfis, videoLinks, videos }) {
  const client = {
    from(tableName) {
      if (tableName === "trilha_perfis") {
        return {
          select() {
            return this;
          },
          eq() {
            return Promise.resolve({ data: perfis, error: null });
          },
        };
      }

      if (tableName === "trilha_videos") {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          order() {
            const sorted = [...videoLinks].sort((left, right) => left.ordem - right.ordem);
            return Promise.resolve({ data: sorted, error: null });
          },
        };
      }

      if (tableName === "video_catalog") {
        return {
          select() {
            return this;
          },
          in() {
            return this;
          },
          eq() {
            return Promise.resolve({ data: videos, error: null });
          },
        };
      }

      throw new Error(`Tabela inesperada no mock: ${tableName}`);
    },
  };

  return client;
}

async function testReturnsNullWhenProfileNotEnabledForTrilha() {
  const client = createMockClient({ perfis: [{ perfil: "Adolescência" }], videoLinks: [], videos: [] });

  const result = await trilhasRepository.findFirstApprovedVideoByTrilhaAndProfile("trilha-1", "Infância", client);

  assert.equal(result, null);
}

async function testReturnsNullWhenTrilhaHasNoApprovedVideos() {
  const client = createMockClient({
    perfis: [{ perfil: "Infância" }],
    videoLinks: [{ video_id: "video-1", ordem: 1 }],
    videos: [],
  });

  const result = await trilhasRepository.findFirstApprovedVideoByTrilhaAndProfile("trilha-1", "Infância", client);

  assert.equal(result, null);
}

async function testReturnsFirstApprovedVideoRespectingOrdem() {
  const client = createMockClient({
    perfis: [{ perfil: "Infância" }],
    videoLinks: [
      { video_id: "video-1", ordem: 2 },
      { video_id: "video-2", ordem: 1 },
    ],
    videos: [
      { id: "video-1", nome_do_arquivo: "aula-2.mp4", status: true },
      { id: "video-2", nome_do_arquivo: "aula-1.mp4", status: true },
    ],
  });

  const result = await trilhasRepository.findFirstApprovedVideoByTrilhaAndProfile("trilha-1", "Infância", client);

  assert.equal(result.id, "video-2");
  assert.equal(result.ordem, 1);
}

async function testMatchesProfileIgnoringCaseAndAccents() {
  const client = createMockClient({
    perfis: [{ perfil: "Pré-infância" }],
    videoLinks: [{ video_id: "video-1", ordem: 1 }],
    videos: [{ id: "video-1", nome_do_arquivo: "aula-1.mp4", status: true }],
  });

  const result = await trilhasRepository.findFirstApprovedVideoByTrilhaAndProfile("trilha-1", "Pré-Infância", client);

  assert.equal(result.id, "video-1");
}

async function testSkipsUnapprovedVideoAndReturnsApprovedOne() {
  const client = createMockClient({
    perfis: [{ perfil: "Infância" }],
    videoLinks: [
      { video_id: "video-1", ordem: 1 },
      { video_id: "video-2", ordem: 2 },
    ],
    // video-1 nao aprovado nao aparece no resultado de listApproved (status = true)
    videos: [{ id: "video-2", nome_do_arquivo: "aula-2.mp4", status: true }],
  });

  const result = await trilhasRepository.findFirstApprovedVideoByTrilhaAndProfile("trilha-1", "Infância", client);

  assert.equal(result.id, "video-2");
  assert.equal(result.ordem, 2);
}

async function testFindByTrilhaNameReturnsFirstMatch() {
  const client = {
    from(tableName) {
      assert.equal(tableName, "trilhas");
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        order() {
          return this;
        },
        limit() {
          return this;
        },
        maybeSingle() {
          return Promise.resolve({ data: { id: "trilha-1", trilha: "Trilha A" }, error: null });
        },
      };
    },
  };

  const result = await trilhasRepository.findByTrilhaName("Trilha A", client);

  assert.equal(result.id, "trilha-1");
}

async function main() {
  await testReturnsNullWhenProfileNotEnabledForTrilha();
  await testReturnsNullWhenTrilhaHasNoApprovedVideos();
  await testReturnsFirstApprovedVideoRespectingOrdem();
  await testMatchesProfileIgnoringCaseAndAccents();
  await testSkipsUnapprovedVideoAndReturnsApprovedOne();
  await testFindByTrilhaNameReturnsFirstMatch();

  console.log("trilhas-repository tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
