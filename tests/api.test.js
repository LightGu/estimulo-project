const assert = require("node:assert/strict");
const express = require("express");

const createApp = require("../src/api/app");

async function main() {
  const app = createApp({
    healthController: {
      redisClient: {
        ping: async () => "PONG",
      },
      dispatchQueueFactory: () => ({
        getJobCounts: async () => ({ waiting: 0, active: 0, completed: 2, failed: 0, delayed: 0 }),
      }),
      dispatchLogsService: {
        listRecent: async () => [{ criado_em: new Date(Date.now() - 5 * 60000).toISOString() }],
      },
    },
    campaignService: {
      create: async (payload) => ({ id: "campaign-1", ...payload }),
      createAndQueue: async (payload) => ({
        campaign: { id: "campaign-queued-1", trilha: payload.trilha || payload.nome, ativo: true },
        campaign_groups: payload.group_ids.map((groupId) => ({ campaign_id: "campaign-queued-1", group_id: groupId })),
        trigger_job: { id: "trigger-1", data: { campaign_id: "campaign-queued-1" } },
      }),
    },
    organizationService: {
      list: async () => [{ id: "org-1", nome: "AMBEV" }],
      create: async (payload) => ({ id: "org-2", nome: payload.nome, descricao: payload.descricao ?? null, programa: payload.programa ?? null }),
      update: async (id, payload) => ({ id, nome: "AMBEV", descricao: payload.descricao ?? null, programa: payload.programa ?? null }),
    },
    videoCatalogService: {
      listTrailsByProfile: async () => [],
      listTrailsOverview: async () => [
        {
          perfil_da_jornada: "Infância",
          macrotema: "GESTÃO FINANCEIRA: Dinheiro Organizado",
          trilha: "2.3 Como Cuidar das Finanças para Sobreviver e Crescer",
          videos: [
            { id: "video-1", ordem: 1, ordem_geral: 1, nome_do_arquivo: "1) Principais erros financeiros.mp4", status: true },
            { id: "video-2", ordem: 2, ordem_geral: 2, nome_do_arquivo: "2) Organizando as contas.mp4", status: false },
          ],
        },
      ],
      transcribeByDriveFileId: async (driveFileId, options) => ({
        skipped: options.force !== "true",
        transcript: options.force === "true" ? "Transcricao nova" : "Transcricao existente",
        video: { id: "video-1", drive_file_id: driveFileId },
      }),
      transcribeById: async (id) => ({
        skipped: false,
        transcript: "Transcricao por id",
        video: { id, drive_file_id: "drive-1" },
      }),
      listUnclassified: async () => [
        { id: "unclassified-1", nome_do_arquivo: "novo-video-drive.mp4" },
      ],
      createTrailVideos: async (payload) =>
        payload.video_ids.map((videoId, index) => ({
          id: videoId,
          perfil_da_jornada: payload.perfil_da_jornada,
          macrotema: payload.macrotema,
          trilha: payload.trilha,
          nome_do_arquivo: "novo-video-drive.mp4",
          ordem: index + 1,
          status: false,
        })),
      moveVideoTrail: async (id, payload) => ({
        id,
        perfil_da_jornada: payload.perfil_da_jornada,
        macrotema: payload.macrotema,
        trilha: payload.trilha,
        nome_do_arquivo: "1) Principais erros financeiros.mp4",
        status: true,
      }),
      reorderTrailVideos: async (orderedIds) => orderedIds.map((id, index) => ({ id, ordem: index + 1 })),
    },
    groupService: {
      listWithoutSegment: async () => [
        {
          id: "group-1",
          nome: "Grupo sem segmento",
          evolution_group_id: "120363@g.us",
          segmento: null,
          envia_video: false,
        },
      ],
      syncGroupsFromEvolution: async (payload) => ({
        inserted: 1,
        updated: 1,
        ignored: 0,
        groups: [{ id: "120363@g.us", nome: payload.name_contains || "Grupo", quantidade_membros: 10 }],
      }),
      updateOperationalSettings: async (id, payload) => ({
        id,
        nome: "Grupo sem segmento",
        evolution_group_id: "120363@g.us",
        quantidade_membros: 10,
        organization_id: payload.organization_id,
        segmento: payload.segmento,
        envia_video: payload.envia_video,
        trilha_override: payload.trilha_override,
      }),
      dispatchTestVideo: async (id, payload) => ({
        group: { id, ...payload, evolution_group_id: "120363@g.us" },
        video: { id: "video-1", nome_do_arquivo: "aula.mp4", drive_file_id: "drive-1" },
        dispatch_job: { id: "dispatch-1", name: "dispatch-content", queue: "dispatch" },
      }),
    },
  });

  const server = app.listen(0);

  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  try {
    const postResponse = await fetch(`http://127.0.0.1:${port}/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: "Campanha", organization_id: "org-1", cron_expression: "0 * * * *", ativo: true }),
    });

    assert.equal(postResponse.status, 201);

    const queuedCampaignResponse = await fetch(`http://127.0.0.1:${port}/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nome: "Trilha A",
        organization_id: "org-1",
        group_ids: ["group-1"],
        execution_at: "2026-07-17T10:00:00.000Z",
      }),
    });

    assert.equal(queuedCampaignResponse.status, 201);
    const queuedCampaignPayload = await queuedCampaignResponse.json();
    assert.equal(queuedCampaignPayload.campaign.id, "campaign-queued-1");
    assert.equal(queuedCampaignPayload.campaign_groups[0].group_id, "group-1");
    assert.equal(queuedCampaignPayload.trigger_job.id, "trigger-1");

    const organizationsResponse = await fetch(`http://127.0.0.1:${port}/organizations`);
    assert.equal(organizationsResponse.status, 200);
    const organizationsPayload = await organizationsResponse.json();
    assert.deepEqual(organizationsPayload, [{ id: "org-1", nome: "AMBEV" }]);

    const createOrganizationResponse = await fetch(`http://127.0.0.1:${port}/organizations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: "Nova Organizacao", descricao: "Descricao teste", programa: "Programa teste" }),
    });

    assert.equal(createOrganizationResponse.status, 201);
    const createOrganizationPayload = await createOrganizationResponse.json();
    assert.deepEqual(createOrganizationPayload, {
      id: "org-2",
      nome: "Nova Organizacao",
      descricao: "Descricao teste",
      programa: "Programa teste",
    });

    const updateOrganizationResponse = await fetch(`http://127.0.0.1:${port}/organizations/org-1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ descricao: "Descricao atualizada", programa: "Programa atualizado" }),
    });

    assert.equal(updateOrganizationResponse.status, 200);
    const updateOrganizationPayload = await updateOrganizationResponse.json();
    assert.deepEqual(updateOrganizationPayload, {
      id: "org-1",
      nome: "AMBEV",
      descricao: "Descricao atualizada",
      programa: "Programa atualizado",
    });

    const skippedTranscriptResponse = await fetch(`http://127.0.0.1:${port}/video-catalog/transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drive_file_id: "drive-1" }),
    });

    assert.equal(skippedTranscriptResponse.status, 200);
    const skippedTranscriptPayload = await skippedTranscriptResponse.json();
    assert.equal(skippedTranscriptPayload.skipped, true);
    assert.equal(skippedTranscriptPayload.transcript, "Transcricao existente");

    const forcedTranscriptResponse = await fetch(`http://127.0.0.1:${port}/video-catalog/transcript?force=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drive_file_id: "drive-1" }),
    });

    assert.equal(forcedTranscriptResponse.status, 201);
    const forcedTranscriptPayload = await forcedTranscriptResponse.json();
    assert.equal(forcedTranscriptPayload.skipped, false);
    assert.equal(forcedTranscriptPayload.transcript, "Transcricao nova");

    const transcriptByIdResponse = await fetch(`http://127.0.0.1:${port}/video-catalog/video-1/transcript`, {
      method: "POST",
    });

    assert.equal(transcriptByIdResponse.status, 201);
    const transcriptByIdPayload = await transcriptByIdResponse.json();
    assert.equal(transcriptByIdPayload.transcript, "Transcricao por id");

    const groupSyncResponse = await fetch(`http://127.0.0.1:${port}/groups/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name_contains: "Teste", get_participants: false }),
    });

    assert.equal(groupSyncResponse.status, 200);
    const groupSyncPayload = await groupSyncResponse.json();
    assert.equal(groupSyncPayload.inserted, 1);
    assert.equal(groupSyncPayload.updated, 1);
    assert.equal(groupSyncPayload.ignored, 0);
    assert.deepEqual(groupSyncPayload.groups, [{ id: "120363@g.us", nome: "Teste", quantidade_membros: 10 }]);

    const unclassifiedGroupsResponse = await fetch(`http://127.0.0.1:${port}/groups/unclassified`);
    assert.equal(unclassifiedGroupsResponse.status, 200);
    const unclassifiedGroupsPayload = await unclassifiedGroupsResponse.json();
    assert.deepEqual(unclassifiedGroupsPayload, [
      {
        id: "group-1",
        nome: "Grupo sem segmento",
        evolution_group_id: "120363@g.us",
        segmento: null,
        envia_video: false,
      },
    ]);

    const unclassifiedGroupsPageResponse = await fetch(`http://127.0.0.1:${port}/groups-unclassified.html`);
    assert.equal(unclassifiedGroupsPageResponse.status, 200);
    const unclassifiedGroupsPage = await unclassifiedGroupsPageResponse.text();
    assert.match(unclassifiedGroupsPage, /fetch\(`\/groups\/search\$\{query\}`\)/);
    assert.match(unclassifiedGroupsPage, /fetch\("\/organizations"\)/);
    assert.match(unclassifiedGroupsPage, /name_contains/);
    assert.match(unclassifiedGroupsPage, /fetch\(`\/groups\/\$\{encodeURIComponent\(groupId\)\}`/);
    assert.match(unclassifiedGroupsPage, /fetch\(`\/video-catalog\/\$\{encodeURIComponent\(videoId\)\}\/transcript`/);
    assert.match(unclassifiedGroupsPage, /fetch\("\/campaigns"/);
    assert.match(unclassifiedGroupsPage, /Evolution group id/);

    const groupsAppPageResponse = await fetch(`http://127.0.0.1:${port}/app/grupos.html`);
    assert.equal(groupsAppPageResponse.status, 200);
    const groupsAppPage = await groupsAppPageResponse.text();
    assert.doesNotMatch(groupsAppPage, /mock-data\.js/);
    assert.doesNotMatch(groupsAppPage, /MOCK\./);
    assert.doesNotMatch(groupsAppPage, /id="editTrilha"/);
    assert.match(groupsAppPage, /value="Pr&eacute;-Inf&acirc;ncia"/);
    assert.match(groupsAppPage, /value="Inf&acirc;ncia"/);
    assert.match(groupsAppPage, /value="Adolescente"/);
    assert.match(groupsAppPage, /value="Maturidade"/);
    assert.match(groupsAppPage, /requestJson\("\/groups\/search"\)/);
    assert.match(groupsAppPage, /requestJson\("\/organizations"\)/);
    assert.match(groupsAppPage, /requestJson\("\/groups\/sync"/);
    assert.match(groupsAppPage, /requestJson\(`\/groups\/\$\{encodeURIComponent\(editingGroupId\)\}`/);

    const organizacoesAppPageResponse = await fetch(`http://127.0.0.1:${port}/app/organizacoes.html`);
    assert.equal(organizacoesAppPageResponse.status, 200);
    const organizacoesAppPage = await organizacoesAppPageResponse.text();
    assert.doesNotMatch(organizacoesAppPage, /mock-data\.js/);
    assert.doesNotMatch(organizacoesAppPage, /MOCK\./);
    assert.match(organizacoesAppPage, /requestJson\("\/organizations"\)/);
    assert.match(organizacoesAppPage, /requestJson\("\/groups\/search"\)/);
    assert.match(organizacoesAppPage, /id="newOrgButton"/);
    assert.match(organizacoesAppPage, /id="orgDescricao"/);
    assert.match(organizacoesAppPage, /id="orgPrograma"/);
    assert.match(organizacoesAppPage, /requestJson\(`\/organizations\/\$\{encodeURIComponent\(editingOrgId\)\}`/);
    assert.match(organizacoesAppPage, /requestJson\("\/organizations", \{/);

    const trailsOverviewResponse = await fetch(`http://127.0.0.1:${port}/video-catalog/trails-overview`);
    assert.equal(trailsOverviewResponse.status, 200);
    const trailsOverviewPayload = await trailsOverviewResponse.json();
    assert.equal(trailsOverviewPayload.length, 1);
    assert.equal(trailsOverviewPayload[0].trilha, "2.3 Como Cuidar das Finanças para Sobreviver e Crescer");
    assert.equal(trailsOverviewPayload[0].videos.length, 2);
    assert.equal(trailsOverviewPayload[0].videos[0].nome_do_arquivo, "1) Principais erros financeiros.mp4");

    const trilhasAppPageResponse = await fetch(`http://127.0.0.1:${port}/app/trilhas.html`);
    assert.equal(trilhasAppPageResponse.status, 200);
    const trilhasAppPage = await trilhasAppPageResponse.text();
    assert.doesNotMatch(trilhasAppPage, /mock-data\.js/);
    assert.doesNotMatch(trilhasAppPage, /helpers\.js/);
    assert.doesNotMatch(trilhasAppPage, /MOCK\./);
    assert.match(trilhasAppPage, /requestJson\("\/video-catalog\/trails-overview"\)/);
    assert.match(trilhasAppPage, /nome_do_arquivo/);
    assert.match(trilhasAppPage, /id="newTrailButton" type="button">\+ Nova trilha<\/button>/);
    assert.doesNotMatch(trilhasAppPage, /id="newTrailButton"[^>]*disabled/);
    assert.match(trilhasAppPage, /requestJson\("\/video-catalog\/trails", \{/);
    assert.match(trilhasAppPage, /requestJson\("\/video-catalog\/unclassified"\)/);
    assert.match(trilhasAppPage, /requestJson\(`\/video-catalog\/\$\{encodeURIComponent\(movingVideo\)\}\/move-trail`/);
    assert.match(trilhasAppPage, /requestJson\("\/video-catalog\/reorder", \{/);
    assert.match(trilhasAppPage, /draggable="true"/);
    assert.match(trilhasAppPage, /id="newTrailPerfil"><\/select>/);
    assert.match(trilhasAppPage, /id="newTrailMacrotema"><\/select>/);
    assert.match(trilhasAppPage, /Criar novo macrotema/);
    assert.match(trilhasAppPage, /id="moveTargetPerfil"><\/select>/);
    assert.match(trilhasAppPage, /id="moveTargetMacrotema"><\/select>/);
    assert.match(trilhasAppPage, /id="moveTargetTrilha"><\/select>/);
    assert.doesNotMatch(trilhasAppPage, /id="newTrailVideos"/);

    const unclassifiedResponse = await fetch(`http://127.0.0.1:${port}/video-catalog/unclassified`);
    assert.equal(unclassifiedResponse.status, 200);
    const unclassifiedPayload = await unclassifiedResponse.json();
    assert.deepEqual(unclassifiedPayload, [{ id: "unclassified-1", nome_do_arquivo: "novo-video-drive.mp4" }]);

    const createTrailResponse = await fetch(`http://127.0.0.1:${port}/video-catalog/trails`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        perfil_da_jornada: "Infância",
        macrotema: "GESTÃO FINANCEIRA: Dinheiro Organizado",
        trilha: "Nova trilha teste",
        video_ids: ["unclassified-1"],
      }),
    });

    assert.equal(createTrailResponse.status, 201);
    const createTrailPayload = await createTrailResponse.json();
    assert.equal(createTrailPayload.length, 1);
    assert.equal(createTrailPayload[0].nome_do_arquivo, "novo-video-drive.mp4");

    const moveVideoResponse = await fetch(`http://127.0.0.1:${port}/video-catalog/video-1/move-trail`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        perfil_da_jornada: "Infância",
        macrotema: "GESTÃO FINANCEIRA: Dinheiro Organizado",
        trilha: "Outra trilha",
      }),
    });

    assert.equal(moveVideoResponse.status, 200);
    const moveVideoPayload = await moveVideoResponse.json();
    assert.equal(moveVideoPayload.trilha, "Outra trilha");

    const reorderResponse = await fetch(`http://127.0.0.1:${port}/video-catalog/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ordered_ids: ["video-2", "video-1"] }),
    });

    assert.equal(reorderResponse.status, 200);
    const reorderPayload = await reorderResponse.json();
    assert.deepEqual(reorderPayload, [
      { id: "video-2", ordem: 1 },
      { id: "video-1", ordem: 2 },
    ]);

    const operationalSettingsResponse = await fetch(`http://127.0.0.1:${port}/groups/group-1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        segmento: "Pre infancia",
        organization_id: "org-1",
        envia_video: true,
        trilha_override: "Trilha A",
        nome: "Nao deve ser usado",
      }),
    });

    assert.equal(operationalSettingsResponse.status, 200);
    const operationalSettingsPayload = await operationalSettingsResponse.json();
    assert.deepEqual(operationalSettingsPayload, {
      id: "group-1",
      nome: "Grupo sem segmento",
      evolution_group_id: "120363@g.us",
      quantidade_membros: 10,
      organization_id: "org-1",
      segmento: "Pre infancia",
      envia_video: true,
      trilha_override: "Trilha A",
    });

    const legacyOperationalSettingsResponse = await fetch(`http://127.0.0.1:${port}/groups/group-1/operational-settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segmento: "Infancia" }),
    });

    assert.equal(legacyOperationalSettingsResponse.status, 200);

    const testDispatchResponse = await fetch(`http://127.0.0.1:${port}/groups/group-1/test-dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        segmento: "Pre infancia",
        organization_id: "org-1",
        envia_video: true,
        trilha_override: "Trilha A",
      }),
    });

    assert.equal(testDispatchResponse.status, 202);
    const testDispatchPayload = await testDispatchResponse.json();
    assert.equal(testDispatchPayload.dispatch_job.id, "dispatch-1");

    const healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(healthResponse.status, 200);
    const healthPayload = await healthResponse.json();
    assert.equal(healthPayload.status, "ok");
    assert.equal(healthPayload.checks.application.status, "ok");
    assert.equal(healthPayload.checks.redis.status, "ok");
    assert.ok(healthPayload.checks.redis);

    const unhealthyApp = createApp({
      healthController: {
        redisClient: {
          ping: async () => {
            throw new Error("Redis unavailable");
          },
        },
      },
      campaignService: {
        create: async (payload) => ({ id: "campaign-1", ...payload }),
      },
      organizationService: {
        list: async () => [],
      },
      videoCatalogService: {
        listTrailsByProfile: async () => [],
        listTrailsOverview: async () => [],
        listUnclassified: async () => [],
        transcribeByDriveFileId: async () => ({ skipped: true, transcript: "", video: null }),
        transcribeById: async () => ({ skipped: true, transcript: "", video: null }),
        createTrailVideos: async () => [],
        moveVideoTrail: async (id, payload) => ({ id, ...payload }),
        reorderTrailVideos: async () => [],
      },
      groupService: {
        listWithoutSegment: async () => [],
        syncGroupsFromEvolution: async () => ({
          inserted: 0,
          updated: 0,
          ignored: 0,
          groups: [],
        }),
        updateOperationalSettings: async (id, payload) => ({ id, ...payload }),
        dispatchTestVideo: async (id, payload) => ({
          group: { id, ...payload },
          video: { id: "video-1" },
          dispatch_job: { id: "dispatch-1" },
        }),
      },
    });

    const unhealthyServer = unhealthyApp.listen(0);
    await new Promise((resolve) => unhealthyServer.once("listening", resolve));
    const unhealthyPort = unhealthyServer.address().port;

    try {
      const unhealthyResponse = await fetch(`http://127.0.0.1:${unhealthyPort}/health`);
      assert.equal(unhealthyResponse.status, 503);

      const unhealthyPayload = await unhealthyResponse.json();
      assert.equal(unhealthyPayload.status, "error");
      assert.equal(unhealthyPayload.checks.application.status, "ok");
      assert.equal(unhealthyPayload.checks.redis.status, "error");
      assert.equal(unhealthyPayload.checks.redis.error, "Redis unavailable");
    } finally {
      await new Promise((resolve, reject) => unhealthyServer.close((error) => (error ? reject(error) : resolve())));
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  console.log("api tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
