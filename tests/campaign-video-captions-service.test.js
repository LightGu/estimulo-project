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
  await testRegenerateCaptionNotifiesAiErrorAndRethrows();
  await testNotificationFailureDoesNotBreakRegenerateCaptionFlow();
  await testRegenerateDoesNotReviewEmptyTextFromFailedRow();

  console.log("campaign video captions service tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
