const assert = require("node:assert/strict");

const { createCampaignVideoCaptionsService } = require("../src/services/campaign-video-captions.service");

function createFailingCaptionDependencies(overrides = {}) {
  return {
    videoCaptionsService: {
      selectCaptionForVideo: async () => null,
    },
    captionReviewService: {
      assertCaptionApproved: async () => {
        throw new Error("Transcricao do video ausente");
      },
    },
    videoCatalogRepository: {
      findById: async () => null,
    },
    ...overrides,
  };
}

async function testGenerateCaptionsForCampaignNotifiesAiErrorOnItemFailure() {
  const notifyCalls = [];
  const markErrorCalls = [];
  const service = createCampaignVideoCaptionsService({
    ...createFailingCaptionDependencies(),
    repository: {
      createPending: async () => ({ id: "pending-1" }),
      listByCampaign: async () => [],
      markProcessing: async () => ({}),
      markError: async (id, payload) => {
        markErrorCalls.push({ id, payload });
        return { id, ...payload };
      },
    },
    groupVideoProgressRepository: { listDelivered: async () => [] },
    campaigns: { findById: async () => ({ id: "campaign-1" }) },
    campaignGroups: {
      listGroups: async () => [
        { groups: { id: "group-1", envia_video: true, evolution_group_id: "group-1@g.us" } },
      ],
    },
    videoFlowRepository: {
      findNextApprovedUnsentVideoForGroup: async () => ({ id: "video-1" }),
    },
    notificationsService: {
      notifyAiError: async (payload) => {
        notifyCalls.push(payload);
        return { sent: true };
      },
    },
    logger: {},
  });

  // generateCaptionsForCampaign nao relanca falhas de item individual - apenas
  // loga (event: "campaign_video_captions.item_failed") e segue para o proximo -
  // por isso aqui verificamos o resultado retornado, nao uma rejeicao.
  const result = await service.generateCaptionsForCampaign("campaign-1");

  assert.equal(markErrorCalls.length, 1);
  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0].campaignId, "campaign-1");
  assert.equal(notifyCalls[0].groupId, "group-1");
  assert.equal(notifyCalls[0].videoId, "video-1");
  assert.equal(notifyCalls[0].stage, "legenda");
  assert.match(notifyCalls[0].errorMessage, /Nao foi possivel gerar uma legenda valida/);
  assert.equal(result.generated.length, 0);
}

// A tela da Etapa 2 usa a quantidade de linhas da campanha como total esperado.
// Enquanto as linhas eram criadas uma a uma dentro do laco de geracao, o total
// crescia aos poucos: com 3 de 6 grupos prontos a tela mostrava "100% gerado" e
// habilitava o botao de envio. Todas as linhas precisam existir antes da
// primeira legenda ser gerada.
async function testGenerateCaptionsCreatesEveryRowBeforeGeneratingCaptions() {
  const events = [];
  const groupIds = ["group-1", "group-2", "group-3", "group-4", "group-5", "group-6"];
  const rowsByGroup = new Map();
  const service = createCampaignVideoCaptionsService({
    videoCaptionsService: {
      selectCaptionForVideo: async (videoId, options) => {
        events.push({ type: "generate", group: options.progress_group_id });
        return { text: `Legenda de ${options.progress_group_id}`, caption: { id: `caption-${options.progress_group_id}` } };
      },
    },
    videoCatalogRepository: { findById: async () => ({ id: "video-1", transcript: "transcricao" }) },
    repository: {
      createManyPending: async (payloads) => {
        events.push({ type: "create_many", count: payloads.length });
        return payloads.map((payload, index) => {
          const row = { id: `row-${index + 1}`, ...payload, status: "pendente" };
          rowsByGroup.set(payload.group_id, row);
          return row;
        });
      },
      createPending: async () => {
        throw new Error("createPending nao deveria ser chamado quando o insert em lote existe");
      },
      listByCampaign: async () => [...rowsByGroup.values()],
      markProcessing: async (id) => {
        events.push({ type: "mark_processing", id });
        return { id, status: "processando" };
      },
      markGenerated: async (id, payload) => {
        events.push({ type: "mark_generated", id });
        return { id, status: "gerado", ...payload };
      },
      markError: async (id, payload) => ({ id, status: "erro", ...payload }),
    },
    groupVideoProgressRepository: { listDelivered: async () => [] },
    campaigns: { findById: async () => ({ id: "campaign-1" }), update: async () => ({ id: "campaign-1" }) },
    campaignGroups: {
      listGroups: async () =>
        groupIds.map((groupId) => ({
          groups: { id: groupId, envia_video: true, evolution_group_id: `${groupId}@g.us` },
        })),
    },
    videoFlowRepository: {
      findNextApprovedUnsentVideoForGroup: async (group) => ({ id: `video-${group.id}` }),
    },
    notificationsService: { notifyAiError: async () => ({ sent: true }) },
    settingsService: { getDispatchRulesSettings: async () => ({ auto_generate_caption: true }) },
    logger: {},
  });

  const result = await service.generateCaptionsForCampaign("campaign-1");

  const createMany = events.filter((event) => event.type === "create_many");
  assert.equal(createMany.length, 1, "as linhas devem ser criadas em um unico insert");
  assert.equal(createMany[0].count, 6, "uma linha por grupo do disparo");
  assert.equal(events[0].type, "create_many", "as linhas nascem antes da primeira geracao");

  // Nenhuma legenda pode ter sido gerada antes de todas as linhas existirem.
  const firstGenerateIndex = events.findIndex((event) => event.type === "generate");
  assert.ok(firstGenerateIndex > 0);
  assert.equal(
    events.slice(0, firstGenerateIndex).filter((event) => event.type === "create_many").length,
    1
  );

  assert.equal(result.generated.length, 6);
  assert.equal(result.progress.total, 6);
  assert.equal(events.filter((event) => event.type === "mark_generated").length, 6);

  // Cada grupo recebe a legenda da propria linha, sem troca de ordem.
  const generatedGroups = events.filter((event) => event.type === "generate").map((event) => event.group);
  assert.deepEqual(generatedGroups, groupIds);

  // As linhas nascem em "pendente" (na fila) e nenhuma e marcada como
  // "processando" na criacao: a tela mostrava os 6 videos como "Processando" ao
  // mesmo tempo, como se houvesse uma requisicao de legenda por video em
  // paralelo. Aqui o lote inteiro e criado antes de qualquer mark_processing.
  const firstProcessingIndex = events.findIndex((event) => event.type === "mark_processing");
  assert.equal(events[0].type, "create_many");
  assert.ok(firstProcessingIndex > 0, "nenhuma linha e marcada como processando antes do lote existir");
  assert.equal(events.filter((event) => event.type === "mark_processing").length, 6);

  // Uma linha por vez em "processando": cada mark_processing e imediatamente
  // seguido pela geracao e pelo desfecho da MESMA linha, sem que outra entre em
  // processamento no meio.
  const queueEvents = events.filter((event) =>
    ["mark_processing", "generate", "mark_generated"].includes(event.type)
  );
  assert.deepEqual(
    queueEvents.map((event) => event.type),
    groupIds.flatMap(() => ["mark_processing", "generate", "mark_generated"]),
    "cada video e processado sozinho, em sequencia"
  );
  queueEvents
    .filter((event) => event.type === "mark_processing")
    .forEach((event, index) => {
      assert.equal(event.id, `row-${index + 1}`, "a linha marcada e a do video da vez");
    });
}

async function testRegenerateCaptionNotifiesAiErrorAndRethrows() {
  const notifyCalls = [];
  const markErrorCalls = [];
  const service = createCampaignVideoCaptionsService({
    ...createFailingCaptionDependencies(),
    repository: {
      findById: async (id) => ({
        id,
        campaign_id: "campaign-1",
        group_id: "group-1",
        video_id: "video-1",
        caption_text: "Legenda antiga",
      }),
      listByCampaign: async () => [],
      markProcessing: async () => ({}),
      markError: async (id, payload) => {
        markErrorCalls.push({ id, payload });
        return { id, ...payload };
      },
    },
    notificationsService: {
      notifyAiError: async (payload) => {
        notifyCalls.push(payload);
        return { sent: true };
      },
    },
    logger: {},
  });

  // regenerateCaption, ao contrario de generateCaptionsForCampaign, relanca o
  // erro do item (nao ha loop de multiplos itens a proteger aqui).
  await assert.rejects(
    () => service.regenerateCaption("caption-row-1"),
    /Nao foi possivel gerar uma legenda valida/
  );

  assert.equal(markErrorCalls.length, 1);
  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0].campaignId, "campaign-1");
  assert.equal(notifyCalls[0].groupId, "group-1");
  assert.equal(notifyCalls[0].videoId, "video-1");
  assert.equal(notifyCalls[0].stage, "legenda");
}

async function testNotificationFailureDoesNotBreakRegenerateCaptionFlow() {
  const service = createCampaignVideoCaptionsService({
    ...createFailingCaptionDependencies(),
    repository: {
      findById: async (id) => ({
        id,
        campaign_id: "campaign-1",
        group_id: "group-1",
        video_id: "video-1",
        caption_text: "Legenda antiga",
      }),
      listByCampaign: async () => [],
      markProcessing: async () => ({}),
      markError: async (id, payload) => ({ id, ...payload }),
    },
    notificationsService: {
      notifyAiError: async () => {
        throw new Error("Evolution indisponivel para notificar");
      },
    },
    logger: {},
  });

  // A falha ao notificar (ex.: Evolution fora do ar) nao deve mascarar o erro
  // original de geracao de legenda que regenerateCaption relanca.
  await assert.rejects(
    () => service.regenerateCaption("caption-row-1"),
    /Nao foi possivel gerar uma legenda valida/
  );
}

async function testRegenerateDoesNotReviewEmptyTextFromFailedRow() {
  let reviewCalled = false;
  const service = createCampaignVideoCaptionsService({
    videoCaptionsService: {
      // A selecao ja revisou as candidatas e nao encontrou uma aprovada.
      selectCaptionForVideo: async () => null,
    },
    videoCatalogRepository: {
      findById: async () => ({ transcript: "Transcricao do video" }),
    },
    captionReviewService: {
      assertCaptionApproved: async () => {
        reviewCalled = true;
        throw new Error("Legenda reprovada: Legenda vazia");
      },
    },
    repository: {
      findById: async (id) => ({
        id,
        campaign_id: "campaign-1",
        group_id: "group-1",
        video_id: "video-1",
        caption_text: null,
      }),
      listByCampaign: async () => [],
      markProcessing: async () => ({}),
      markError: async (id, payload) => ({ id, ...payload }),
    },
    notificationsService: { notifyAiError: async () => ({ sent: true }) },
    logger: {},
  });

  await assert.rejects(
    () => service.regenerateCaption("caption-row-1"),
    /Nao foi possivel gerar uma legenda valida para este video/
  );
  assert.equal(reviewCalled, false);
}

async function main() {
  await testGenerateCaptionsForCampaignNotifiesAiErrorOnItemFailure();
  await testGenerateCaptionsCreatesEveryRowBeforeGeneratingCaptions();
  await testRegenerateCaptionNotifiesAiErrorAndRethrows();
  await testNotificationFailureDoesNotBreakRegenerateCaptionFlow();
  await testRegenerateDoesNotReviewEmptyTextFromFailedRow();

  console.log("campaign video captions service tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
