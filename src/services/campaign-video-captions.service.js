const campaignVideoCaptionsRepository = require("../repositories/campaign-video-captions.repository");
const campaignsRepository = require("../repositories/campaigns.repository");
const campaignGroupsRepository = require("../repositories/campaign-groups.repository");
const defaultVideoCaptionsService = require("./video-captions.service");
const defaultVideoCatalogRepository = require("../repositories/video-catalog.repository");
const defaultTrilhasRepository = require("../repositories/trilhas.repository");
const defaultGroupVideoProgressRepository = require("../repositories/group-video-progress.repository");
const { resolveGroupsVideoFlow } = require("./group-video-flow");
const {
  applyCampaignTrailFallback,
  buildCampaignVideoFlowRepository,
  extractCampaignGroup,
  isVideoEnabledGroup,
} = require("../queues/campaign-trigger");
const { resolveVideoTranscript } = require("../queues/dispatch");
const { downloadFromDrive } = require("./google-drive-video-download");
const defaultNotificationsService = require("./notifications.service");
const defaultInAppNotificationsService = require("./in-app-notifications.service");
const defaultSettingsService = require("./settings.service");

function createCampaignVideoCaptionsService(dependencies = {}) {
  const repository = dependencies.repository || campaignVideoCaptionsRepository;
  const campaigns = dependencies.campaigns || campaignsRepository;
  const campaignGroups = dependencies.campaignGroups || campaignGroupsRepository;
  const videoCaptionsService = dependencies.videoCaptionsService || defaultVideoCaptionsService;
  const videoCatalogRepository = dependencies.videoCatalogRepository || defaultVideoCatalogRepository;
  const trilhasRepository = dependencies.trilhasRepository || defaultTrilhasRepository;
  const videoFlowRepository = dependencies.videoFlowRepository || buildCampaignVideoFlowRepository(dependencies);
  const groupVideoProgressRepository = dependencies.groupVideoProgressRepository || defaultGroupVideoProgressRepository;
  const videoDownloader = dependencies.videoDownloader || downloadFromDrive;
  const notificationsService = dependencies.notificationsService || defaultNotificationsService;
  const inAppNotificationsService = dependencies.inAppNotificationsService || defaultInAppNotificationsService;
  const settingsService = dependencies.settingsService || defaultSettingsService;
  const logger = dependencies.logger || console;

  async function resolveDispatchRules() {
    try {
      return await settingsService.getDispatchRulesSettings();
    } catch (error) {
      return {};
    }
  }

  async function filterOutDeliveredRows(rows) {
    if (!rows.length) {
      return rows;
    }

    const groupIds = [...new Set(rows.map((row) => row.group_id))];
    const deliveredByGroupId = new Map(
      await Promise.all(
        groupIds.map(async (groupId) => [
          groupId,
          new Set((await groupVideoProgressRepository.listDelivered(groupId)).map((delivery) => delivery.video_id)),
        ])
      )
    );

    return rows.filter((row) => !deliveredByGroupId.get(row.group_id)?.has(row.video_id));
  }

  async function resolveCampaignDispatchGroups(campaignId) {
    const campaign = await campaigns.findById(campaignId);

    if (!campaign) {
      throw new Error("Campaign not found");
    }

    const campaignGroupRows = await campaignGroups.listGroups(campaignId);
    const groupsWithFallback = await Promise.all(
      campaignGroupRows
        .map(extractCampaignGroup)
        .map((group) => applyCampaignTrailFallback(group, campaign, { trilhasRepository }))
    );
    const groups = groupsWithFallback.filter(isVideoEnabledGroup);
    const dispatchRules = await resolveDispatchRules();

    const flow = await resolveGroupsVideoFlow({
      campaign_id: campaignId,
      groups,
      repository: videoFlowRepository,
      dispatchRules,
      notificationsService,
      inAppNotificationsService,
      logger,
    });

    return { campaign, dispatchGroups: flow.dispatchGroups, dispatchRules };
  }

  async function resolveGeneratedCaption(item, campaignId, usedCaptionIds, options = {}) {
    const transcript = await resolveVideoTranscript(
      { video_catalog: item.video_catalog, video_id: item.video_id },
      videoCatalogRepository
    );
    const autoGenerateCaption = options.autoGenerateCaption !== false;

    // Quando o video ainda nao tem transcricao persistida, baixamos o arquivo do
    // Drive para que selectCaptionForVideo consiga transcrever e gerar a legenda
    // (mesmo fluxo do dispatch). Sem isso a selecao retorna null e a legenda e
    // reprovada como "Legenda vazia".
    const shouldDownloadVideo = autoGenerateCaption && !transcript && Boolean(item.drive_file_id || item.video_id);
    const downloadedVideo = shouldDownloadVideo
      ? Promise.resolve(
          videoDownloader({
            videoCatalogRepository,
            videoCatalogRecord: item.video_catalog,
            videoId: item.video_id,
            driveFileId: item.drive_file_id,
          })
        )
      : undefined;

    // selectCaptionForVideo pode nao chegar a aguardar o download (ex.: ja existe
    // legenda aprovada reutilizavel). Evita "unhandled rejection" caso o Drive
    // falhe sem que ninguem consuma a promise; o erro real, se relevante, sera
    // propagado quando o download for de fato aguardado.
    if (downloadedVideo) {
      downloadedVideo.catch(() => {});
    }

    const selected = await videoCaptionsService.selectCaptionForVideo(item.video_id, {
      transcript,
      downloadedVideo,
      requireCaptionReview: true,
      autoGenerateCaption,
      campaign_id: campaignId,
      group_id: item.group_id,
      progress_group_id: item.progress_group_id,
      excludeCaptionIds: Array.from(usedCaptionIds),
    });

    if (!selected || !selected.text) {
      // "Gerar legenda automaticamente" desativado: sem legenda pronta reaproveitavel,
      // a legenda fica vazia para o usuario editar manualmente, sem marcar como erro.
      if (!autoGenerateCaption) {
        return { caption_id: undefined, caption_text: "" };
      }

      // selectCaptionForVideo ja faz a revisao da legenda candidata. A linha da
      // campanha pode estar vazia justamente porque a tentativa anterior falhou;
      // revisar esse valor antigo produzia o falso erro "Legenda vazia" e escondia
      // a causa real (por exemplo, uma candidata reprovada na revisao factual).
      throw new Error("Nao foi possivel gerar uma legenda valida para este video");
    }

    if (selected.caption && selected.caption.id) {
      usedCaptionIds.add(selected.caption.id);
    }

    return {
      caption_id: selected.caption && selected.caption.id,
      caption_text: selected.text,
    };
  }

  async function generateCaptionForItem(item, campaignId, usedCaptionIds, options = {}) {
    const pendingRow = await repository.createPending({
      campaign_id: campaignId,
      group_id: item.progress_group_id,
      video_id: item.video_id,
    });

    try {
      const generated = await resolveGeneratedCaption(item, campaignId, usedCaptionIds, options);

      return repository.markGenerated(pendingRow.id, generated);
    } catch (error) {
      await repository.markError(pendingRow.id, { erro_mensagem: error.message });
      await notificationsService
        .notifyAiError({
          campaignId,
          groupId: item.progress_group_id,
          videoId: item.video_id,
          stage: "legenda",
          errorMessage: error.message,
        })
        .catch((notifyError) => {
          logger.error &&
            logger.error(
              JSON.stringify({
                event: "campaign_video_captions.notification_failed",
                campaign_id: campaignId,
                group_id: item.progress_group_id,
                video_id: item.video_id,
                error_message: notifyError.message,
              })
            );
        });
      throw error;
    }
  }

  async function generateCaptionsForCampaign(campaignId) {
    if (!campaignId) {
      throw new Error("Campaign id is required");
    }

    const { dispatchGroups, dispatchRules } = await resolveCampaignDispatchGroups(campaignId);
    const usedCaptionIds = new Set();
    const results = [];

    for (const item of dispatchGroups) {
      try {
        results.push(
          await generateCaptionForItem(item, campaignId, usedCaptionIds, {
            autoGenerateCaption: dispatchRules.auto_generate_caption,
          })
        );
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

    const allRows = await repository.listByCampaign(campaignId);
    const rows = await filterOutDeliveredRows(allRows);
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

  async function regenerateCaption(campaignVideoCaptionId) {
    if (!campaignVideoCaptionId) {
      throw new Error("Campaign video caption id is required");
    }

    const row = await repository.findById(campaignVideoCaptionId);

    if (!row) {
      throw new Error("Campaign video caption not found");
    }

    const otherRows = (await repository.listByCampaign(row.campaign_id)).filter(
      (candidate) => candidate.id !== row.id
    );
    const usedCaptionIds = new Set(otherRows.map((candidate) => candidate.caption_id).filter(Boolean));

    const item = {
      video_catalog: row.video_catalog,
      video_id: row.video_id,
      group_id: row.group_id,
      progress_group_id: row.group_id,
      drive_file_id: row.video_catalog && row.video_catalog.drive_file_id,
      legenda: row.caption_text,
    };

    await repository.markProcessing(row.id);

    try {
      const generated = await resolveGeneratedCaption(item, row.campaign_id, usedCaptionIds);
      const updated = await repository.markGenerated(row.id, generated);

      const progress = await getCaptionProgress(row.campaign_id);

      if (progress.total > 0 && progress.pendente === 0 && progress.erro === 0) {
        await campaigns.update(row.campaign_id, { status: "programado" });
      }

      return updated;
    } catch (error) {
      await repository.markError(row.id, { erro_mensagem: error.message });
      await notificationsService
        .notifyAiError({
          campaignId: row.campaign_id,
          groupId: row.group_id,
          videoId: row.video_id,
          stage: "legenda",
          errorMessage: error.message,
        })
        .catch((notifyError) => {
          logger.error &&
            logger.error(
              JSON.stringify({
                event: "campaign_video_captions.notification_failed",
                campaign_id: row.campaign_id,
                group_id: row.group_id,
                video_id: row.video_id,
                error_message: notifyError.message,
              })
            );
        });
      throw error;
    }
  }

  return {
    generateCaptionsForCampaign,
    getCaptionProgress,
    regenerateCaption,
    updateCaptionText,
  };
}

module.exports = createCampaignVideoCaptionsService();
module.exports.createCampaignVideoCaptionsService = createCampaignVideoCaptionsService;
