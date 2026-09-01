const assert = require("node:assert/strict");

const { createGroupsService } = require("../src/services/groups.service");

// previewNextTrilha ("trilha recomendada" na tela de Grupos) e forceNextVideo
// (override manual do proximo video) nunca tinham teste - services.test.js so
// cobre create/sync/updateOperationalSettings/dispatchTestVideo. Sao as duas
// funcoes do groups.service.js diretamente expostas ao usuario final na tela
// de Envio Automatizado.

async function main() {
  // ---------- previewNextTrilha ----------
  {
    await assert.rejects(
      () => createGroupsService({ repository: {} }).previewNextTrilha(""),
      /Group id is required/
    );

    await assert.rejects(
      () =>
        createGroupsService({ repository: { findById: async () => null } }).previewNextTrilha("group-1"),
      /Group not found/
    );

    // Motor de sequenciamento nao tem proxima trilha (fim da sequencia, ou
    // grupo sem perfil): preview deve devolver null, nao lancar.
    {
      const service = createGroupsService({
        repository: { findById: async () => ({ id: "group-1", profile_id: null }) },
        trilhaSequenceService: { resolveNextTrilhaForGroup: async () => null },
      });

      const preview = await service.previewNextTrilha("group-1");
      assert.equal(preview, null);
    }

    // Caminho feliz: o resultado do motor e enriquecido com macrotema/trilha
    // buscados na tabela de trilhas.
    {
      const service = createGroupsService({
        repository: { findById: async () => ({ id: "group-1", profile_id: "profile-1" }) },
        trilhaSequenceService: {
          resolveNextTrilhaForGroup: async () => ({
            trilha_id: "trilha-1",
            profile_id: "profile-1",
            checkpoint: false,
            reason: "sequencia",
          }),
        },
        trilhasRepository: {
          findById: async (id) => {
            assert.equal(id, "trilha-1");
            return { id: "trilha-1", macrotema: "Financas", trilha: "Trilha 1" };
          },
        },
      });

      const preview = await service.previewNextTrilha("group-1");
      assert.deepEqual(preview, {
        trilha_id: "trilha-1",
        profile_id: "profile-1",
        checkpoint: false,
        reason: "sequencia",
        macrotema: "Financas",
        trilha: "Trilha 1",
      });
    }

    // Trilha apontada pelo motor foi apagada nesse meio-tempo: degrada para
    // macrotema/trilha null em vez de lancar.
    {
      const service = createGroupsService({
        repository: { findById: async () => ({ id: "group-1", profile_id: "profile-1" }) },
        trilhaSequenceService: {
          resolveNextTrilhaForGroup: async () => ({ trilha_id: "trilha-apagada", profile_id: "profile-1" }),
        },
        trilhasRepository: { findById: async () => null },
      });

      const preview = await service.previewNextTrilha("group-1");
      assert.equal(preview.macrotema, null);
      assert.equal(preview.trilha, null);
    }
  }

  // ---------- forceNextVideo ----------
  {
    await assert.rejects(
      () => createGroupsService({ repository: {} }).forceNextVideo("", { video_id: "video-1" }),
      /Group id is required/
    );

    await assert.rejects(
      () => createGroupsService({ repository: {} }).forceNextVideo("group-1", {}),
      /Video id is required/
    );

    await assert.rejects(
      () =>
        createGroupsService({ repository: { findById: async () => null } }).forceNextVideo("group-1", {
          video_id: "video-1",
        }),
      /Group not found/
    );

    await assert.rejects(
      () =>
        createGroupsService({
          repository: { findById: async () => ({ id: "group-1", trilha_id: null }) },
        }).forceNextVideo("group-1", { video_id: "video-1" }),
      /Group has no trilha selected/
    );

    // Video existe no catalogo mas nao pertence a trilha ATUAL do grupo -
    // bloqueado, senao o forcado poderia pular pra um video de outra trilha.
    await assert.rejects(
      () =>
        createGroupsService({
          repository: { findById: async () => ({ id: "group-1", trilha_id: "trilha-1" }) },
          trilhasRepository: { listVideoLinksByTrilha: async () => [{ video_id: "video-outro" }] },
        }).forceNextVideo("group-1", { video_id: "video-1" }),
      /Video does not belong to the group's current trilha/
    );

    // Video pertence a trilha mas foi removido do catalogo.
    await assert.rejects(
      () =>
        createGroupsService({
          repository: { findById: async () => ({ id: "group-1", trilha_id: "trilha-1" }) },
          trilhasRepository: { listVideoLinksByTrilha: async () => [{ video_id: "video-1" }] },
          videoCatalogRepository: { findById: async () => null },
        }).forceNextVideo("group-1", { video_id: "video-1" }),
      /Video not found/
    );

    // Caminho feliz: grava forced_next_video_id no grupo.
    {
      const updateCalls = [];
      const service = createGroupsService({
        repository: {
          findById: async () => ({ id: "group-1", trilha_id: "trilha-1" }),
          update: async (id, payload) => {
            updateCalls.push({ id, payload });
            return { id, ...payload };
          },
        },
        trilhasRepository: { listVideoLinksByTrilha: async () => [{ video_id: "video-1" }] },
        videoCatalogRepository: { findById: async () => ({ id: "video-1" }) },
      });

      const result = await service.forceNextVideo("group-1", { video_id: "video-1" });
      assert.deepEqual(updateCalls[0], { id: "group-1", payload: { forced_next_video_id: "video-1" } });
      assert.equal(result.forced_next_video_id, "video-1");

      // Aceita tambem o alias videoId (camelCase), usado por algum chamador.
      updateCalls.length = 0;
      await service.forceNextVideo("group-1", { videoId: "video-1" });
      assert.equal(updateCalls[0].payload.forced_next_video_id, "video-1");
    }
  }

  console.log("groups preview/force-video tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
