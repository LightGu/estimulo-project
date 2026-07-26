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
    dispatchLogsService: {
      listForReport: async (filters) => {
        if (filters.startDate === "2026-12-31") {
          throw new Error("Start date cannot be in the future");
        }

        return [
          {
            id: "log-1",
            status: filters.status || "enviado",
            criado_em: "2026-07-21T09:41:00.000Z",
            campaigns: {
              id: "campaign-1",
              trilha: "Trilha A",
              data_envio: "2026-07-21",
            },
            groups: {
              id: "group-1",
              nome: "Grupo sem segmento",
              organization_id: "org-1",
              organizations: { id: "org-1", nome: "AMBEV" },
            },
            video_catalog: { id: "video-1", nome_do_arquivo: "video.mp4" },
          },
        ];
      },
    },
    campaignService: {
      create: async (payload) => ({ id: "campaign-1", ...payload }),
      createAndQueue: async (payload) => ({
        campaign: { id: "campaign-queued-1", trilha: payload.trilha || payload.nome, ativo: true },
        campaign_groups: payload.group_ids.map((groupId) => ({ campaign_id: "campaign-queued-1", group_id: groupId })),
        trigger_job: { id: "trigger-1", data: { campaign_id: "campaign-queued-1" } },
      }),
      listWithSummary: async () => [
        { id: "campaign-1", trilha: "Campanha do dia 21/07", status: "programado", grupos_total: 2, data_envio: "2026-07-21" },
      ],
      getById: async (id) => ({ id, trilha: "Campanha do dia 21/07", status: "programado" }),
      getGroupsDetail: async (campaignId) => [
        {
          group_id: "group-1",
          nome: "Grupo sem segmento",
          evolution_group_id: "120363@g.us",
          video_id: "video-1",
          status: "enviado",
          criado_em: "2026-07-21T09:41:12.000Z",
        },
      ],
      dispatchCampaign: async (payload) => ({
        campaign: { id: "campaign-dispatch-1", trilha: payload.trilha, status: "gerando_legendas" },
        campaign_groups: (payload.group_ids || []).map((groupId) => ({ campaign_id: "campaign-dispatch-1", group_id: groupId })),
        trigger_job: null,
      }),
      confirmDispatch: async (campaignId, payload) => {
        if (campaignId === "campaign-pending") {
          const error = new Error("Existem legendas pendentes para esta campanha");
          error.code = "CAPTIONS_PENDING";
          throw error;
        }

        return {
          campaign: { id: campaignId, status: "programado" },
          trigger_job: { id: "trigger-confirm-1", data: { campaign_id: campaignId } },
        };
      },
    },
    campaignVideoCaptionsService: {
      getCaptionProgress: async (campaignId) => ({
        total: 2,
        gerado: 1,
        erro: 0,
        pendente: 1,
        pct: 50,
        items: [
          {
            id: "cvc-1",
            campaign_id: campaignId,
            status: "gerado",
            caption_text: "Legenda pronta",
            groups: { nome: "Grupo A" },
            video_catalog: { nome_do_arquivo: "video-a.mp4", trilha_segmento: "Trilha A" },
          },
          {
            id: "cvc-2",
            campaign_id: campaignId,
            status: "processando",
            caption_text: null,
            groups: { nome: "Grupo B" },
            video_catalog: { nome_do_arquivo: "video-b.mp4", trilha_segmento: "Trilha A" },
          },
        ],
      }),
      updateCaptionText: async (id, captionText) => ({ id, caption_text: captionText, status: "gerado" }),
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
      getById: async (id) => (id === "group-1" ? { id, nome: "Grupo sem segmento", trilha_override: "Trilha A" } : null),
    },
    groupVideoProgressService: {
      getGroupProgressSummary: async (groupId) => ({
        current: { trilha: "Trilha A", total: 2, enviados: 1, concluida: false, next_video: { id: "video-a2" }, rows: [] },
        history: [{ trilha: "Trilha B", enviados: 3, total: 3, concluida: true, ultima_atividade: "2026-07-10" }],
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
      body: JSON.stringify({ nome: "Campanha", cron_expression: "0 * * * *", ativo: true }),
    });

    assert.equal(postResponse.status, 201);

    const queuedCampaignResponse = await fetch(`http://127.0.0.1:${port}/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nome: "Trilha A",
        group_ids: ["group-1"],
        execution_at: "2026-07-17T10:00:00.000Z",
      }),
    });

    assert.equal(queuedCampaignResponse.status, 201);
    const queuedCampaignPayload = await queuedCampaignResponse.json();
    assert.equal(queuedCampaignPayload.campaign.id, "campaign-queued-1");
    assert.equal(queuedCampaignPayload.campaign_groups[0].group_id, "group-1");
    assert.equal(queuedCampaignPayload.trigger_job.id, "trigger-1");

    const listCampaignsResponse = await fetch(`http://127.0.0.1:${port}/campaigns`);
    assert.equal(listCampaignsResponse.status, 200);
    const listCampaignsPayload = await listCampaignsResponse.json();
    assert.equal(listCampaignsPayload[0].status, "programado");
    assert.equal(listCampaignsPayload[0].grupos_total, 2);

    const getCampaignResponse = await fetch(`http://127.0.0.1:${port}/campaigns/campaign-1`);
    assert.equal(getCampaignResponse.status, 200);
    const getCampaignPayload = await getCampaignResponse.json();
    assert.equal(getCampaignPayload.id, "campaign-1");

    const campaignGroupsResponse = await fetch(`http://127.0.0.1:${port}/campaigns/campaign-1/groups`);
    assert.equal(campaignGroupsResponse.status, 200);
    const campaignGroupsPayload = await campaignGroupsResponse.json();
    assert.equal(campaignGroupsPayload[0].group_id, "group-1");
    assert.equal(campaignGroupsPayload[0].status, "enviado");

    const dispatchCampaignResponse = await fetch(`http://127.0.0.1:${port}/campaigns/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        group_ids: ["group-1"],
        execution_at: "2026-07-24T10:00:00.000Z",
      }),
    });

    assert.equal(dispatchCampaignResponse.status, 202);
    const dispatchCampaignPayload = await dispatchCampaignResponse.json();
    assert.equal(dispatchCampaignPayload.campaign.id, "campaign-dispatch-1");
    assert.equal(dispatchCampaignPayload.campaign.status, "gerando_legendas");
    assert.equal(dispatchCampaignPayload.trigger_job, null);

    const captionsProgressResponse = await fetch(`http://127.0.0.1:${port}/campaigns/campaign-dispatch-1/captions/progress`);
    assert.equal(captionsProgressResponse.status, 200);
    const captionsProgressPayload = await captionsProgressResponse.json();
    assert.equal(captionsProgressPayload.total, 2);
    assert.equal(captionsProgressPayload.pendente, 1);
    assert.equal(captionsProgressPayload.items[0].status, "gerado");

    const updateCaptionResponse = await fetch(`http://127.0.0.1:${port}/campaigns/campaign-dispatch-1/captions/cvc-2`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caption_text: "Legenda editada manualmente" }),
    });

    assert.equal(updateCaptionResponse.status, 200);
    const updateCaptionPayload = await updateCaptionResponse.json();
    assert.equal(updateCaptionPayload.caption_text, "Legenda editada manualmente");

    const confirmDispatchResponse = await fetch(`http://127.0.0.1:${port}/campaigns/campaign-dispatch-1/dispatch/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ execution_at: "2026-07-24T10:00:00.000Z" }),
    });

    assert.equal(confirmDispatchResponse.status, 200);
    const confirmDispatchPayload = await confirmDispatchResponse.json();
    assert.equal(confirmDispatchPayload.campaign.status, "programado");
    assert.equal(confirmDispatchPayload.trigger_job.id, "trigger-confirm-1");

    const confirmDispatchPendingResponse = await fetch(`http://127.0.0.1:${port}/campaigns/campaign-pending/dispatch/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ execution_at: "2026-07-24T10:00:00.000Z" }),
    });

    assert.equal(confirmDispatchPendingResponse.status, 409);

    const envioAutomatizadoPageResponse = await fetch(`http://127.0.0.1:${port}/app/envio-automatizado.html`);
    assert.equal(envioAutomatizadoPageResponse.status, 200);
    const envioAutomatizadoPage = await envioAutomatizadoPageResponse.text();
    assert.match(envioAutomatizadoPage, /requestJson\("\/campaigns\/dispatch"/);
    assert.match(envioAutomatizadoPage, /\/captions\/progress/);
    assert.match(envioAutomatizadoPage, /\/dispatch\/confirm/);
    assert.match(envioAutomatizadoPage, /id="backToConfigButton"/);

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

    const reportResponse = await fetch(`http://127.0.0.1:${port}/reports/dispatches?status=enviado`);
    assert.equal(reportResponse.status, 200);
    const reportPayload = await reportResponse.json();
    assert.equal(reportPayload[0].status, "enviado");
    assert.equal(reportPayload[0].groups.organizations.nome, "AMBEV");
    assert.equal(reportPayload[0].groups.nome, "Grupo sem segmento");

    const reportFutureDateResponse = await fetch(`http://127.0.0.1:${port}/reports/dispatches?start_date=2026-12-31`);
    assert.equal(reportFutureDateResponse.status, 400);

    const relatoriosPageResponse = await fetch(`http://127.0.0.1:${port}/app/relatorios.html`);
    assert.equal(relatoriosPageResponse.status, 200);
    const relatoriosPage = await relatoriosPageResponse.text();
    assert.match(relatoriosPage, /requestJson\(`\/reports\/dispatches/);
    assert.match(relatoriosPage, /id="groupFilter"/);
    assert.doesNotMatch(relatoriosPage, /campanhaFilter/);
    assert.doesNotMatch(relatoriosPage, /trilhaFilter/);

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

    const groupProgressResponse = await fetch(`http://127.0.0.1:${port}/groups/group-1/video-progress`);
    assert.equal(groupProgressResponse.status, 200);
    const groupProgressPayload = await groupProgressResponse.json();
    assert.equal(groupProgressPayload.current.trilha, "Trilha A");
    assert.equal(groupProgressPayload.current.next_video.id, "video-a2");
    assert.equal(groupProgressPayload.history[0].trilha, "Trilha B");

    const missingGroupProgressResponse = await fetch(`http://127.0.0.1:${port}/groups/group-missing/video-progress`);
    assert.equal(missingGroupProgressResponse.status, 404);

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
