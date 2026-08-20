const assert = require("node:assert/strict");
const express = require("express");

const createApp = require("../src/api/app");

async function main() {
  const app = createApp({
    authGate: {
      enabled: false,
    },
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
      remove: async (campaignId) => {
        if (campaignId === "campaign-delivered") {
          const error = new Error("Campaign already has delivered dispatches");
          error.code = "CAMPAIGN_HAS_DELIVERIES";
          throw error;
        }

        return { id: campaignId };
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
      regenerateCaption: async (id) => {
        if (id === "cvc-missing") {
          throw new Error("Campaign video caption not found");
        }

        if (id === "cvc-still-failing") {
          throw new Error("Falha ao gerar legenda via IA");
        }

        return { id, caption_text: "Legenda regenerada", status: "gerado" };
      },
    },
    organizationService: {
      list: async () => [{ id: "org-1", nome: "AMBEV" }],
      create: async (payload) => ({ id: "org-2", nome: payload.nome, descricao: payload.descricao ?? null, programa: payload.programa ?? null }),
      update: async (id, payload) => ({ id, nome: "AMBEV", descricao: payload.descricao ?? null, programa: payload.programa ?? null }),
      delete: async (id) => {
        if (id !== "org-1") {
          throw new Error("Organization not found");
        }

        return { id, nome: "AMBEV" };
      },
    },
    videoCatalogService: {
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
    },
    trilhasService: {
      listAll: async () => [
        {
          id: "trilha-1",
          macrotema: "GESTÃO FINANCEIRA: Dinheiro Organizado",
          trilha: "2.3 Como Cuidar das Finanças para Sobreviver e Crescer",
        },
      ],
      listOverview: async () => [
        {
          id: "trilha-1",
          perfis: ["Infância", "Adolescência"],
          macrotema: "GESTÃO FINANCEIRA: Dinheiro Organizado",
          trilha: "2.3 Como Cuidar das Finanças para Sobreviver e Crescer",
          videos: [
            { id: "video-1", ordem: 1, nome_do_arquivo: "1) Principais erros financeiros.mp4", status: true },
            { id: "video-2", ordem: 2, nome_do_arquivo: "2) Organizando as contas.mp4", status: false },
          ],
        },
      ],
      listByPerfil: async (perfil) => {
        if (!["Pré-infância", "Infância", "Adolescência", "Maturidade"].includes(perfil)) {
          throw new Error(`Invalid perfil: ${perfil}`);
        }

        return [
          {
            id: "trilha-1",
            macrotema: "GESTÃO FINANCEIRA: Dinheiro Organizado",
            trilha: "2.3 Como Cuidar das Finanças para Sobreviver e Crescer",
            videos_count: 1,
            first_video: { id: "video-1", ordem: 1, nome_do_arquivo: "1) Principais erros financeiros.mp4" },
            perfil,
          },
        ];
      },
      listSelectableVideos: async () => [
        {
          id: "video-1",
          nome_do_arquivo: "1) Principais erros financeiros.mp4",
          status: true,
          trilhas: [{ id: "trilha-1", macrotema: "GESTÃO FINANCEIRA: Dinheiro Organizado", trilha: "2.3 Como Cuidar das Finanças para Sobreviver e Crescer" }],
        },
        { id: "unclassified-1", nome_do_arquivo: "novo-video-drive.mp4", status: false, trilhas: [] },
      ],
      createTrilha: async (payload) => ({
        id: "trilha-2",
        macrotema: payload.macrotema,
        trilha: payload.trilha,
        perfis: payload.perfis,
        videos: payload.video_ids.map((id, index) => ({
          id,
          ordem: index + 1,
          nome_do_arquivo: id === "video-1" ? "1) Principais erros financeiros.mp4" : "novo-video-drive.mp4",
          status: id === "video-1",
        })),
      }),
      addVideoToTrilha: async (trilhaId, videoId) => ({ trilha_id: trilhaId, video_id: videoId, ordem: 3 }),
      removeVideoFromTrilha: async (trilhaId, videoId) => ({ trilha_id: trilhaId, video_id: videoId }),
      moveVideoBetweenTrilhas: async (videoId, payload) => ({
        video_id: videoId,
        from_trilha_id: payload.from_trilha_id,
        to_trilha_id: payload.to_trilha_id,
      }),
      reorderTrilhaVideos: async (trilhaId, orderedVideoIds) =>
        orderedVideoIds.map((id, index) => ({ trilha_id: trilhaId, video_id: id, ordem: index + 1 })),
      renameTrilha: async (id, payload) => ({ id, macrotema: payload.macrotema, trilha: payload.trilha }),
      removeTrilha: async (id) => ({ id }),
      updateTrailPerfis: async (id, perfis) => perfis,
    },
    groupProfilesService: {
      list: async () => [{ id: "profile-1", nome: "Eufrasio" }],
      listMergeRecords: async () => [
        { id: "merge-1", survivor_id: "profile-1", discarded_id: "profile-2", discarded_nome: "Maturidade" },
      ],
      unmerge: async (id) => {
        if (id === "profile-sem-fusao") {
          throw new Error("Profile was not created from a merge");
        }

        return { restored: { id: "profile-2", nome: "Maturidade" }, survivor: { id, nome: "Adolescência" } };
      },
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
        trilha_id: payload.trilha_id,
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
    authService: {
      listUsers: async () => [
        { id: "app-user-1", username: "operador", active: true, created_at: "2026-07-01T00:00:00.000Z", last_login_at: null },
      ],
      createUser: async ({ username, password }) => {
        if (!username) throw new Error("Informe um nome de usuario.");
        if (!password || password.length < 8) throw new Error("A senha deve ter ao menos 8 caracteres.");
        if (username === "operador") {
          const error = new Error("duplicate key value violates unique constraint");
          error.code = "23505";
          throw error;
        }
        return { id: "app-user-2", username, active: true, created_at: "2026-08-20T00:00:00.000Z", last_login_at: null };
      },
      setActive: async (id, active) => ({ id, username: "operador", active, created_at: "2026-07-01T00:00:00.000Z" }),
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

    const regenerateCaptionResponse = await fetch(
      `http://127.0.0.1:${port}/campaigns/campaign-dispatch-1/captions/cvc-2/regenerate`,
      { method: "POST" }
    );
    assert.equal(regenerateCaptionResponse.status, 200);
    const regenerateCaptionPayload = await regenerateCaptionResponse.json();
    assert.equal(regenerateCaptionPayload.status, "gerado");
    assert.equal(regenerateCaptionPayload.caption_text, "Legenda regenerada");

    const regenerateMissingResponse = await fetch(
      `http://127.0.0.1:${port}/campaigns/campaign-dispatch-1/captions/cvc-missing/regenerate`,
      { method: "POST" }
    );
    assert.equal(regenerateMissingResponse.status, 404);

    const regenerateStillFailingResponse = await fetch(
      `http://127.0.0.1:${port}/campaigns/campaign-dispatch-1/captions/cvc-still-failing/regenerate`,
      { method: "POST" }
    );
    assert.equal(regenerateStillFailingResponse.status, 422);
    const regenerateStillFailingPayload = await regenerateStillFailingResponse.json();
    assert.match(regenerateStillFailingPayload.error, /Falha ao gerar legenda/);

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

    const removeCampaignResponse = await fetch(`http://127.0.0.1:${port}/campaigns/campaign-1`, {
      method: "DELETE",
    });
    assert.equal(removeCampaignResponse.status, 204);

    const removeDeliveredResponse = await fetch(`http://127.0.0.1:${port}/campaigns/campaign-delivered`, {
      method: "DELETE",
    });
    assert.equal(removeDeliveredResponse.status, 409);
    const removeDeliveredPayload = await removeDeliveredResponse.json();
    assert.match(removeDeliveredPayload.error, /não pode ser apagado/);

    const envioAutomatizadoPageResponse = await fetch(`http://127.0.0.1:${port}/app/envio-automatizado.html`);
    assert.equal(envioAutomatizadoPageResponse.status, 200);
    const envioAutomatizadoPage = await envioAutomatizadoPageResponse.text();
    assert.match(envioAutomatizadoPage, /requestJson\("\/campaigns\/dispatch"/);
    assert.match(envioAutomatizadoPage, /\/captions\/progress/);
    assert.match(envioAutomatizadoPage, /\/dispatch\/confirm/);
    assert.match(envioAutomatizadoPage, /id="backToConfigButton"/);
    // A etapa 2 precisa sobreviver a um refresh: sem persistir o disparo em
    // andamento, a campanha ja criada (com legendas geradas) ficava orfa no banco,
    // sem caminho de volta na interface.
    assert.match(envioAutomatizadoPage, /estimulo-envio-automatizado-flow/);
    assert.match(envioAutomatizadoPage, /restoreDispatchFlow/);
    assert.match(envioAutomatizadoPage, /clearDispatchFlow/);
    // Linha com erro de geracao mostra o motivo guardado em erro_mensagem.
    assert.match(envioAutomatizadoPage, /erro_mensagem/);
    assert.match(envioAutomatizadoPage, /id="statError"/);

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

    const deleteOrganizationResponse = await fetch(`http://127.0.0.1:${port}/organizations/org-1`, {
      method: "DELETE",
    });

    assert.equal(deleteOrganizationResponse.status, 200);
    assert.deepEqual(await deleteOrganizationResponse.json(), { id: "org-1", nome: "AMBEV" });

    const deleteMissingOrganizationResponse = await fetch(`http://127.0.0.1:${port}/organizations/org-inexistente`, {
      method: "DELETE",
    });

    assert.equal(deleteMissingOrganizationResponse.status, 404);
    assert.deepEqual(await deleteMissingOrganizationResponse.json(), { error: "Organization not found" });

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
    assert.match(groupsAppPage, /requestJson\("\/group-profiles"\)/);
    assert.match(groupsAppPage, /requestJson\(`\/groups\/search\$\{query\}`\)/);
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
    assert.match(organizacoesAppPage, /id="deleteFromOrgInfoModal"/);
    assert.match(organizacoesAppPage, /requestJson\(`\/organizations\/\$\{encodeURIComponent\(org\.id\)\}`, \{ method: "DELETE" \}\)/);
    // Excluir a organizacao mantem os grupos; eles apenas perdem o vinculo (ON DELETE SET NULL).
    assert.match(organizacoesAppPage, /serão mantidos, apenas ficarão sem organização/);
    assert.doesNotMatch(organizacoesAppPage, /state\.groups\.filter\(\(group\) => group\.organization_id !== org\.id\)/);

    const trilhasResponse = await fetch(`http://127.0.0.1:${port}/trilhas`);
    assert.equal(trilhasResponse.status, 200);
    const trilhasPayload = await trilhasResponse.json();
    assert.equal(trilhasPayload.length, 1);
    assert.equal(trilhasPayload[0].id, "trilha-1");

    const trailsOverviewResponse = await fetch(`http://127.0.0.1:${port}/trilhas/overview`);
    assert.equal(trailsOverviewResponse.status, 200);
    const trailsOverviewPayload = await trailsOverviewResponse.json();
    assert.equal(trailsOverviewPayload.length, 1);
    assert.equal(trailsOverviewPayload[0].trilha, "2.3 Como Cuidar das Finanças para Sobreviver e Crescer");
    assert.equal(trailsOverviewPayload[0].videos.length, 2);
    assert.equal(trailsOverviewPayload[0].videos[0].nome_do_arquivo, "1) Principais erros financeiros.mp4");

    const trilhasByPerfilResponse = await fetch(`http://127.0.0.1:${port}/trilhas/by-perfil?perfil=${encodeURIComponent("Infância")}`);
    assert.equal(trilhasByPerfilResponse.status, 200);
    const trilhasByPerfilPayload = await trilhasByPerfilResponse.json();
    assert.equal(trilhasByPerfilPayload.length, 1);
    assert.equal(trilhasByPerfilPayload[0].id, "trilha-1");
    assert.equal(trilhasByPerfilPayload[0].videos_count, 1);

    const trilhasByPerfilInvalidResponse = await fetch(`http://127.0.0.1:${port}/trilhas/by-perfil?perfil=Invalido`);
    assert.equal(trilhasByPerfilInvalidResponse.status, 400);

    const trilhasAppPageResponse = await fetch(`http://127.0.0.1:${port}/app/trilhas.html`);
    assert.equal(trilhasAppPageResponse.status, 200);
    const trilhasAppPage = await trilhasAppPageResponse.text();
    assert.doesNotMatch(trilhasAppPage, /mock-data\.js/);
    assert.doesNotMatch(trilhasAppPage, /helpers\.js/);
    assert.doesNotMatch(trilhasAppPage, /MOCK\./);
    assert.match(trilhasAppPage, /requestJson\("\/trilhas\/overview"\)/);
    assert.match(trilhasAppPage, /nome_do_arquivo/);
    assert.match(trilhasAppPage, /id="newTrailButton" type="button">\+ Nova trilha<\/button>/);
    assert.doesNotMatch(trilhasAppPage, /id="newTrailButton"[^>]*disabled/);
    assert.match(trilhasAppPage, /requestJson\("\/trilhas", \{/);
    assert.match(trilhasAppPage, /requestJson\("\/trilhas\/selectable-videos"\)/);
    assert.match(trilhasAppPage, /requestJson\(`\/trilhas\/\$\{encodeURIComponent\(movingVideo\.trilhaId\)\}\/videos\/\$\{encodeURIComponent\(movingVideo\.videoId\)\}\/move`/);
    assert.match(trilhasAppPage, /requestJson\(`\/trilhas\/\$\{encodeURIComponent\(trail\.id\)\}\/reorder`, \{/);
    assert.match(trilhasAppPage, /draggable="true"/);
    assert.match(trilhasAppPage, /id="newTrailPerfil"><\/div>/);
    assert.match(trilhasAppPage, /id="newTrailMacrotema"><\/select>/);
    assert.match(trilhasAppPage, /Criar novo macrotema/);
    assert.doesNotMatch(trilhasAppPage, /id="organizationSelect"/);
    assert.doesNotMatch(trilhasAppPage, /organization_id/);
    assert.match(trilhasAppPage, /id="moveTargetTrilha"><\/select>/);
    assert.doesNotMatch(trilhasAppPage, /id="newTrailVideos"/);
    assert.match(trilhasAppPage, /requestJson\("\/group-profiles"\)/);
    assert.match(trilhasAppPage, /requestJson\(`\/trilhas\/\$\{encodeURIComponent\(renameContext\.trilhaId\)\}`/);
    assert.match(trilhasAppPage, /requestJson\(`\/trilhas\/\$\{encodeURIComponent\(trail\.id\)\}\/perfis`/);

    // ---------- perfis de grupo: desfundir ----------
    const configPageResponse = await fetch(`http://127.0.0.1:${port}/app/configuracoes.html`);
    assert.equal(configPageResponse.status, 200);
    const configPage = await configPageResponse.text();
    assert.match(configPage, /fetch\("\/group-profiles\/merges"\)/);
    assert.match(configPage, /data-unmerge-profile/);
    assert.match(configPage, /\/unmerge`, \{ method: "POST" \}/);

    const mergesResponse = await fetch(`http://127.0.0.1:${port}/group-profiles/merges`);
    assert.equal(mergesResponse.status, 200);
    const mergesPayload = await mergesResponse.json();
    assert.equal(mergesPayload[0].discarded_nome, "Maturidade");

    const unmergeResponse = await fetch(`http://127.0.0.1:${port}/group-profiles/profile-1/unmerge`, {
      method: "POST",
    });
    assert.equal(unmergeResponse.status, 200);
    const unmergePayload = await unmergeResponse.json();
    assert.equal(unmergePayload.restored.nome, "Maturidade");
    assert.equal(unmergePayload.survivor.nome, "Adolescência");

    const unmergeMissingResponse = await fetch(`http://127.0.0.1:${port}/group-profiles/profile-sem-fusao/unmerge`, {
      method: "POST",
    });
    assert.equal(unmergeMissingResponse.status, 404);
    const unmergeMissingPayload = await unmergeMissingResponse.json();
    assert.equal(unmergeMissingPayload.error, "Profile was not created from a merge");

    const selectableVideosResponse = await fetch(`http://127.0.0.1:${port}/trilhas/selectable-videos`);
    assert.equal(selectableVideosResponse.status, 200);
    const selectableVideosPayload = await selectableVideosResponse.json();
    assert.equal(selectableVideosPayload.length, 2);
    assert.equal(selectableVideosPayload[0].trilhas.length, 1);
    assert.equal(selectableVideosPayload[1].trilhas.length, 0);

    // Teste central do requisito: criar trilha misturando um video ja classificado
    // em outra trilha (video-1) com um video novo/nao classificado (unclassified-1).
    const createTrailResponse = await fetch(`http://127.0.0.1:${port}/trilhas`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        perfis: ["Infância", "Adolescência"],
        macrotema: "GESTÃO FINANCEIRA: Dinheiro Organizado",
        trilha: "Nova trilha teste",
        video_ids: ["video-1", "unclassified-1"],
      }),
    });

    assert.equal(createTrailResponse.status, 201);
    const createTrailPayload = await createTrailResponse.json();
    assert.equal(createTrailPayload.id, "trilha-2");
    assert.equal(createTrailPayload.videos.length, 2);
    assert.equal(createTrailPayload.videos[0].nome_do_arquivo, "1) Principais erros financeiros.mp4");
    assert.equal(createTrailPayload.videos[1].nome_do_arquivo, "novo-video-drive.mp4");

    const addVideoResponse = await fetch(`http://127.0.0.1:${port}/trilhas/trilha-1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_id: "unclassified-1" }),
    });

    assert.equal(addVideoResponse.status, 201);
    const addVideoPayload = await addVideoResponse.json();
    assert.equal(addVideoPayload.trilha_id, "trilha-1");
    assert.equal(addVideoPayload.video_id, "unclassified-1");

    const removeVideoResponse = await fetch(`http://127.0.0.1:${port}/trilhas/trilha-1/videos/video-2`, {
      method: "DELETE",
    });

    assert.equal(removeVideoResponse.status, 200);
    const removeVideoPayload = await removeVideoResponse.json();
    assert.equal(removeVideoPayload.video_id, "video-2");

    const moveVideoResponse = await fetch(`http://127.0.0.1:${port}/trilhas/trilha-1/videos/video-1/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to_trilha_id: "trilha-2" }),
    });

    assert.equal(moveVideoResponse.status, 200);
    const moveVideoPayload = await moveVideoResponse.json();
    assert.equal(moveVideoPayload.from_trilha_id, "trilha-1");
    assert.equal(moveVideoPayload.to_trilha_id, "trilha-2");

    const renameTrilhaResponse = await fetch(`http://127.0.0.1:${port}/trilhas/trilha-1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trilha: "2.3 Cuidando do Dinheiro" }),
    });

    assert.equal(renameTrilhaResponse.status, 200);
    const renameTrilhaPayload = await renameTrilhaResponse.json();
    assert.equal(renameTrilhaPayload.trilha, "2.3 Cuidando do Dinheiro");

    const updateTrailPerfisResponse = await fetch(`http://127.0.0.1:${port}/trilhas/trilha-1/perfis`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ perfis: ["Infância", "Adolescência"] }),
    });

    assert.equal(updateTrailPerfisResponse.status, 200);
    const updateTrailPerfisPayload = await updateTrailPerfisResponse.json();
    assert.deepEqual(updateTrailPerfisPayload.perfis, ["Infância", "Adolescência"]);

    const reorderResponse = await fetch(`http://127.0.0.1:${port}/trilhas/trilha-1/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ordered_video_ids: ["video-2", "video-1"] }),
    });

    assert.equal(reorderResponse.status, 200);
    const reorderPayload = await reorderResponse.json();
    assert.deepEqual(reorderPayload, [
      { trilha_id: "trilha-1", video_id: "video-2", ordem: 1 },
      { trilha_id: "trilha-1", video_id: "video-1", ordem: 2 },
    ]);

    const removeTrilhaResponse = await fetch(`http://127.0.0.1:${port}/trilhas/trilha-2`, {
      method: "DELETE",
    });

    assert.equal(removeTrilhaResponse.status, 200);
    const removeTrilhaPayload = await removeTrilhaResponse.json();
    assert.equal(removeTrilhaPayload.id, "trilha-2");

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

    const trilhaIdOperationalSettingsResponse = await fetch(`http://127.0.0.1:${port}/groups/group-1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trilha_id: "trilha-1" }),
    });

    assert.equal(trilhaIdOperationalSettingsResponse.status, 200);
    const trilhaIdOperationalSettingsPayload = await trilhaIdOperationalSettingsResponse.json();
    assert.equal(trilhaIdOperationalSettingsPayload.trilha_id, "trilha-1");

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

    const testDispatchByTrilhaIdResponse = await fetch(`http://127.0.0.1:${port}/groups/group-1/test-dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        segmento: "Pre infancia",
        envia_video: true,
        trilha_id: "trilha-1",
      }),
    });

    assert.equal(testDispatchByTrilhaIdResponse.status, 202);
    const testDispatchByTrilhaIdPayload = await testDispatchByTrilhaIdResponse.json();
    assert.equal(testDispatchByTrilhaIdPayload.group.trilha_id, "trilha-1");

    const groupProgressResponse = await fetch(`http://127.0.0.1:${port}/groups/group-1/video-progress`);
    assert.equal(groupProgressResponse.status, 200);
    const groupProgressPayload = await groupProgressResponse.json();
    assert.equal(groupProgressPayload.current.trilha, "Trilha A");
    assert.equal(groupProgressPayload.current.next_video.id, "video-a2");
    assert.equal(groupProgressPayload.history[0].trilha, "Trilha B");

    const missingGroupProgressResponse = await fetch(`http://127.0.0.1:${port}/groups/group-missing/video-progress`);
    assert.equal(missingGroupProgressResponse.status, 404);

    process.env.ESTIMULO_ADMIN_MASTER_PASSWORD = "!35Estimulo@246";

    const listAppUsersResponse = await fetch(`http://127.0.0.1:${port}/settings/app-users`);
    assert.equal(listAppUsersResponse.status, 200);
    const appUsersPayload = await listAppUsersResponse.json();
    assert.equal(appUsersPayload[0].username, "operador");
    assert.equal(appUsersPayload[0].password_hash, undefined);

    // /access/register fica fora do authGate de proposito: qualquer um pode
    // criar seu proprio login sabendo so a senha mestra, sem sessao previa.
    const wrongMasterPasswordResponse = await fetch(`http://127.0.0.1:${port}/access/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "novo", password: "senhaforte1", master_password: "errada" }),
    });
    assert.equal(wrongMasterPasswordResponse.status, 403);

    const duplicateAppUserResponse = await fetch(`http://127.0.0.1:${port}/access/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "operador", password: "senhaforte1", master_password: "!35Estimulo@246" }),
    });
    assert.equal(duplicateAppUserResponse.status, 409);

    const createAppUserResponse = await fetch(`http://127.0.0.1:${port}/access/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "novo", password: "senhaforte1", master_password: "!35Estimulo@246" }),
    });
    assert.equal(createAppUserResponse.status, 201);
    const createAppUserPayload = await createAppUserResponse.json();
    assert.equal(createAppUserPayload.username, "novo");

    const deactivateAppUserResponse = await fetch(`http://127.0.0.1:${port}/settings/app-users/app-user-1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: false, master_password: "!35Estimulo@246" }),
    });
    assert.equal(deactivateAppUserResponse.status, 200);
    const deactivateAppUserPayload = await deactivateAppUserResponse.json();
    assert.equal(deactivateAppUserPayload.active, false);

    delete process.env.ESTIMULO_ADMIN_MASTER_PASSWORD;

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
        transcribeByDriveFileId: async () => ({ skipped: true, transcript: "", video: null }),
        transcribeById: async () => ({ skipped: true, transcript: "", video: null }),
      },
      trilhasService: {
        listByOrganization: async () => [],
        listOverview: async () => [],
        listSelectableVideos: async () => [],
        createTrilha: async () => ({ id: "trilha-1", videos: [] }),
        addVideoToTrilha: async (trilhaId, videoId) => ({ trilha_id: trilhaId, video_id: videoId }),
        removeVideoFromTrilha: async (trilhaId, videoId) => ({ trilha_id: trilhaId, video_id: videoId }),
        moveVideoBetweenTrilhas: async (videoId, payload) => ({ video_id: videoId, ...payload }),
        reorderTrilhaVideos: async () => [],
        renameTrilha: async (id, payload) => ({ id, ...payload }),
        removeTrilha: async (id) => ({ id }),
        updateTrailPerfis: async (id, perfis) => perfis,
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
