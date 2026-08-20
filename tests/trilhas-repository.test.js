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

async function testListTrilhasByProfileIdReturnsDedupedOrderedTrilhas() {
  const trilhasResult = [
    { id: "trilha-1", macrotema: "GESTÃO FINANCEIRA", trilha: "2.1 Fundamentos" },
    { id: "trilha-2", macrotema: "VENDAS", trilha: "3.1 Fundamentos" },
  ];

  const client = {
    from(tableName) {
      if (tableName === "trilha_perfis") {
        return {
          select() {
            return this;
          },
          eq(column, value) {
            assert.equal(column, "profile_id");
            assert.equal(value, "profile-1");
            // trilha-2 repetida de proposito: a funcao deve deduplicar por trilha_id.
            return Promise.resolve({
              data: [{ trilha_id: "trilha-2" }, { trilha_id: "trilha-1" }, { trilha_id: "trilha-2" }],
              error: null,
            });
          },
        };
      }

      if (tableName === "trilhas") {
        return {
          select() {
            return this;
          },
          in(column, ids) {
            assert.equal(column, "id");
            assert.deepEqual([...ids].sort(), ["trilha-1", "trilha-2"]);
            return this;
          },
          order() {
            return this;
          },
          then(resolve) {
            resolve({ data: trilhasResult, error: null });
          },
        };
      }

      throw new Error(`Tabela inesperada no mock: ${tableName}`);
    },
  };

  const result = await trilhasRepository.listTrilhasByProfileId("profile-1", client);

  assert.equal(result.length, 2);
  assert.deepEqual(result.map((trilha) => trilha.id), ["trilha-1", "trilha-2"]);
}

async function testListTrilhasByProfileIdReturnsEmptyWhenNoLinks() {
  const client = {
    from(tableName) {
      assert.equal(tableName, "trilha_perfis");
      return {
        select() {
          return this;
        },
        eq() {
          return Promise.resolve({ data: [], error: null });
        },
      };
    },
  };

  const result = await trilhasRepository.listTrilhasByProfileId("profile-sem-trilhas", client);

  assert.deepEqual(result, []);
}

async function testListTrilhaPerfisByProfileOrdersByOrdem() {
  const rows = [
    { trilha_id: "trilha-2", profile_id: "profile-1", ordem: 2 },
    { trilha_id: "trilha-1", profile_id: "profile-1", ordem: 1 },
  ];

  const client = {
    from(tableName) {
      assert.equal(tableName, "trilha_perfis");
      return {
        select() {
          return this;
        },
        eq(column, value) {
          assert.equal(column, "profile_id");
          assert.equal(value, "profile-1");
          return this;
        },
        order(column, options) {
          assert.equal(column, "ordem");
          assert.deepEqual(options, { ascending: true });
          const sorted = [...rows].sort((left, right) => left.ordem - right.ordem);
          return Promise.resolve({ data: sorted, error: null });
        },
      };
    },
  };

  const result = await trilhasRepository.listTrilhaPerfisByProfile("profile-1", client);

  assert.deepEqual(result.map((row) => row.trilha_id), ["trilha-1", "trilha-2"]);
}

async function testReorderTrilhaPerfisForProfileWritesSequentialOrdem() {
  const updates = [];

  const client = {
    from(tableName) {
      assert.equal(tableName, "trilha_perfis");
      return {
        update(payload) {
          return {
            eq(column, value) {
              updates.push({ column, value, payload });
              return this;
            },
            select() {
              return this;
            },
            single() {
              return Promise.resolve({ data: { ...payload }, error: null });
            },
          };
        },
      };
    },
  };

  const result = await trilhasRepository.reorderTrilhaPerfisForProfile(
    "profile-1",
    ["trilha-2", "trilha-1"],
    client
  );

  assert.equal(result.length, 2);
  // Duas chamadas .eq() por update (profile_id, depois trilha_id) - a segunda
  // carrega o ordem correto no payload.
  const trilhaIdCalls = updates.filter((call) => call.column === "trilha_id");
  assert.deepEqual(trilhaIdCalls.map((call) => [call.value, call.payload.ordem]), [
    ["trilha-2", 1],
    ["trilha-1", 2],
  ]);
}

async function testAddTrilhaToProfileSequenceComputesNextOrdem() {
  const existingRows = [
    { trilha_id: "trilha-1", profile_id: "profile-1", ordem: 1 },
    { trilha_id: "trilha-2", profile_id: "profile-1", ordem: 2 },
  ];
  let insertedPayload = null;

  const client = {
    from(tableName) {
      assert.equal(tableName, "trilha_perfis");
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        order() {
          return Promise.resolve({ data: existingRows, error: null });
        },
        insert(payload) {
          insertedPayload = payload;
          return this;
        },
        single() {
          return Promise.resolve({ data: { id: "tp-3", ...insertedPayload }, error: null });
        },
      };
    },
  };

  const result = await trilhasRepository.addTrilhaToProfileSequence("trilha-3", "profile-1", "Infância", client);

  assert.equal(insertedPayload.ordem, 3);
  assert.equal(insertedPayload.trilha_id, "trilha-3");
  assert.equal(insertedPayload.profile_id, "profile-1");
  assert.equal(insertedPayload.perfil, "Infância");
  assert.equal(result.id, "tp-3");
}

async function main() {
  await testReturnsNullWhenProfileNotEnabledForTrilha();
  await testReturnsNullWhenTrilhaHasNoApprovedVideos();
  await testReturnsFirstApprovedVideoRespectingOrdem();
  await testMatchesProfileIgnoringCaseAndAccents();
  await testSkipsUnapprovedVideoAndReturnsApprovedOne();
  await testFindByTrilhaNameReturnsFirstMatch();
  await testListTrilhasByProfileIdReturnsDedupedOrderedTrilhas();
  await testListTrilhasByProfileIdReturnsEmptyWhenNoLinks();
  await testListTrilhaPerfisByProfileOrdersByOrdem();
  await testReorderTrilhaPerfisForProfileWritesSequentialOrdem();
  await testAddTrilhaToProfileSequenceComputesNextOrdem();

  console.log("trilhas-repository tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
