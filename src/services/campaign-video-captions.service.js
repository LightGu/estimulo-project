const campaignVideoCaptionsRepository = require("../repositories/campaign-video-captions.repository");
const campaignsRepository = require("../repositories/campaigns.repository");
const campaignGroupsRepository = require("../repositories/campaign-groups.repository");
const defaultVideoCaptionsService = require("./video-captions.service");
const defaultCaptionReviewService = require("./caption-review.service");
const defaultVideoCatalogRepository = require("../repositories/video-catalog.repository");
const { resolveGroupsVideoFlow } = require("./group-video-flow");
const {
  applyCampaignTrailFallback,
  buildCampaignVideoFlowRepository,
  extractCampaignGroup,
  isVideoEnabledGroup,
} = require("../queues/campaign-trigger");
const { resolveVideoTranscript } = require("../queues/dispatch");

function createCampaignVideoCaptionsService(dependencies = {}) {
  const repository = dependencies.repository || campaignVideoCaptionsRepository;
  const campaigns = dependencies.campaigns || campaignsRepository;
  const campaignGroups = dependencies.campaignGroups || campaignGroupsRepository;
  const videoCaptionsService = dependencies.videoCaptionsService || defaultVideoCaptionsService;
  const captionReviewService = dependencies.captionReviewService || defaultCaptionReviewService;
  const videoCatalogRepository = dependencies.videoCatalogRepository || defaultVideoCatalogRepository;
  const videoFlowRepository = dependencies.videoFlowRepository || buildCampaignVideoFlowRepository(dependencies);
  const logger = dependencies.logger || console;

  async function resolveCampaignDispatchGroups(campaignId) {
    const campaign = await campaigns.findById(campaignId);

    if (!campaign) {
      throw new Error("Campaign not found");
    }

    const campaignGroupRows = await campaignGroups.listGroups(campaignId);
    const groups = campaignGroupRows
      .map(extractCampaignGroup)
      .map((group) => applyCampaignTrailFallback(group, campaign))
      .filter(isVideoEnabledGroup);

    const flow = await resolveGroupsVideoFlow({
      campaign_id: campaignId,
      groups,
      repository: videoFlowRepository,
      logger,
    });

    return { campaign, dispatchGroups: flow.dispatchGroups };
  }

  async function generateCaptionForItem(item, campaignId, usedCaptionIds) {
    const pendingRow = await repository.createPending({
      campaign_id: campaignId,
      group_id: item.progress_group_id,
      video_id: item.video_id,
    });

    try {
      const transcript = await resolveVideoTranscript(
        { video_catalog: item.video_catalog, video_id: item.video_id },
        videoCatalogRepository
      );

      const selected = await videoCaptionsService.selectCaptionForVideo(item.video_id, {
        transcript,
        requireCaptionReview: true,
        campaign_id: campaignId,
        group_id: item.group_id,
        progress_group_id: item.progress_group_id,
        excludeCaptionIds: Array.from(usedCaptionIds),
      });

      if (!selected || !selected.text) {
        await captionReviewService.assertCaptionApproved({
          caption: item.legenda,
          transcript,
          campaign_id: campaignId,
          group_id: item.group_id,
          progress_group_id: item.progress_group_id,
          video_id: item.video_id,
        });

        throw new Error("Nao foi possivel gerar uma legenda valida para este video");
      }

      if (selected.caption && selected.caption.id) {
        usedCaptionIds.add(selected.caption.id);
      }

      return repository.markGenerated(pendingRow.id, {
        caption_id: selected.caption && selected.caption.id,
        caption_text: selected.text,
      });
    } catch (error) {
      await repository.markError(pendingRow.id, { erro_mensagem: error.message });
      throw error;
    }
  }

  async function generateCaptionsForCampaign(campaignId) {
    if (!campaignId) {
      throw new Error("Campaign id is required");
    }

    const { dispatchGroups } = await resolveCampaignDispatchGroups(campaignId);
    const usedCaptionIds = new Set();
    const results = [];

    for (const item of dispatchGroups) {
      try {
        results.push(await generateCaptionForItem(item, campaignId, usedCaptionIds));
      } catch (error) {
        logger.error &&
          logger.error(
            JSON.stringify({
              event: "campaign_video_captions.item_failed",
              campaign_id: campaignId,
              group_id: item.group_id,
              video_id: item.video_id,
              error_message: error.message,
            })
          );
      }
    }

    const progress = await getCaptionProgress(campaignId);

    if (progress.total > 0 && progress.pendente === 0 && progress.erro === 0) {
      await campaigns.update(campaignId, { status: "programado" });
    }

    return { generated: results, progress };
  }

  async function getCaptionProgress(campaignId) {
    if (!campaignId) {
      throw new Error("Campaign id is required");
    }

    const rows = await repository.listByCampaign(campaignId);
    const total = rows.length;
    const gerado = rows.filter((row) => row.status === "gerado").length;
    const erro = rows.filter((row) => row.status === "erro").length;
    const pendente = total - gerado;
    const pct = total ? Math.round((gerado / total) * 100) : 0;

    return {
      total,
      gerado,
      erro,
      pendente,
      pct,
      items: rows,
    };
  }

  async function updateCaptionText(campaignVideoCaptionId, captionText) {
    if (!campaignVideoCaptionId) {
      throw new Error("Campaign video caption id is required");
    }

    const text = String(captionText || "").trim();

    if (!text) {
      throw new Error("Caption text is required");
    }

    return repository.updateCaptionText(campaignVideoCaptionId, { caption_text: text });
  }

  return {
    generateCaptionsForCampaign,
    getCaptionProgress,
    updateCaptionText,
  };
}

module.exports = createCampaignVideoCaptionsService();
module.exports.createCampaignVideoCaptionsService = createCampaignVideoCaptionsService;
