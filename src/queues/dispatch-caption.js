/*
  Resolucao de legenda do video no disparo.
  Extraido de queues/dispatch.js junto com dispatch-media.js, para separar
  "qual texto acompanha o video" de "como o video e enfileirado e entregue".

  Cobre a escolha da legenda aprovada, a leitura da transcricao, a geracao
  antecipada antes de enfileirar e a marcacao de uso apos o envio.
*/
const defaultCaptionReviewService = require("../services/caption-review.service");
const defaultVideoCaptionsService = require("../services/video-captions.service");
const defaultVideoCatalogRepository = require("../repositories/video-catalog.repository");

async function resolveDispatchCaption(jobData, captionSelector, logger = console, options = {}) {
  const fallbackCaption = jobData.legenda || "";

  // caption_generated=true indica que a legenda ja foi gerada/revisada na Etapa 2
  // (tela envio-automatizado, tabela campaign_video_captions) e o usuario ja viu
  // esse texto especifico. Nesse caso ela e definitiva e nao deve ser trocada por
  // outra no dispatch — mesmo quando caption_id vem nulo (legenda de teste inserida
  // manualmente, ou linha sem video_captions.id associado). Sem essa checagem por
  // caption_generated, o dispatch chamava a IA de novo para "sortear" uma legenda
  // diferente, gerando texto novo e consumindo cota desnecessariamente.
  if ((jobData.caption_id || jobData.caption_generated) && fallbackCaption) {
    return {
      caption: jobData.caption_id ? { id: jobData.caption_id } : null,
      generated: Boolean(jobData.caption_generated),
      // Ja passou pela revisao factual na Etapa 2 (campaign-video-captions.service
      // chama selectCaptionForVideo com requireCaptionReview). Revisar de novo aqui
      // era uma segunda chamada ao Gemini por grupo sobre exatamente o mesmo par
      // legenda/transcricao — o que dobrava o consumo da cota diaria e fazia o envio
      // falhar por 429 justamente com a legenda pronta.
      reviewed: true,
      text: fallbackCaption,
    };
  }

  if (!jobData.video_id || !captionSelector || typeof captionSelector.selectCaptionForVideo !== "function") {
    return {
      caption: null,
      generated: false,
      reviewed: false,
      text: fallbackCaption,
    };
  }

  let selected;

  try {
    selected = await captionSelector.selectCaptionForVideo(jobData.video_id, options);
  } catch (error) {
    logger.warn &&
      logger.warn(
        JSON.stringify({
          event: "dispatch.caption.selection_failed",
          campaign_id: jobData.campaign_id,
          group_id: jobData.group_id,
          progress_group_id: jobData.progress_group_id,
          video_id: jobData.video_id,
          error_message: error.message,
        })
      );

    if (options.failOnCaptionError) {
      throw error;
    }

    return {
      caption: null,
      generated: false,
      reviewed: false,
      text: fallbackCaption,
    };
  }

  if (!selected || !selected.text) {
    return {
      caption: null,
      generated: false,
      reviewed: false,
      text: fallbackCaption,
    };
  }

  logger.info &&
    logger.info(
      JSON.stringify({
        event: "dispatch.caption.selected",
        campaign_id: jobData.campaign_id,
        group_id: jobData.group_id,
        progress_group_id: jobData.progress_group_id,
        video_id: jobData.video_id,
        caption_id: selected.caption && selected.caption.id,
        generated: Boolean(selected.generated),
      })
    );

  // selectCaptionForVideo ja revisou a legenda quando requireCaptionReview estava
  // ligado (tanto a reaproveitada do banco quanto a gerada agora).
  return { ...selected, reviewed: Boolean(options.requireCaptionReview) };
}

async function resolveVideoTranscript(jobData, videoCatalogRepository = defaultVideoCatalogRepository) {
  const catalogTranscript = jobData.video_catalog && (jobData.video_catalog.transcript || jobData.video_catalog.transcricao);

  if (catalogTranscript) {
    return String(catalogTranscript).trim();
  }

  if (!jobData.video_id || !videoCatalogRepository || typeof videoCatalogRepository.findById !== "function") {
    return "";
  }

  const video = await videoCatalogRepository.findById(jobData.video_id);

  return String((video && (video.transcript || video.transcricao)) || "").trim();
}

async function prepareDispatchCaptionBeforeQueue(jobData, dependencies = {}) {
  const {
    captionReviewService = defaultCaptionReviewService,
    logger = console,
    videoCaptionsService = defaultVideoCaptionsService,
    videoCatalogRepository = defaultVideoCatalogRepository,
  } = dependencies;
  const transcript = await resolveVideoTranscript(jobData, videoCatalogRepository);

  if (!jobData.video_id) {
    return {
      caption: null,
      generated: false,
      text: jobData.legenda || "",
    };
  }

  if (!jobData.video_id || !videoCaptionsService || typeof videoCaptionsService.selectCaptionForVideo !== "function") {
    if (captionReviewService && typeof captionReviewService.assertCaptionApproved === "function") {
      await captionReviewService.assertCaptionApproved({
        caption: jobData.legenda,
        transcript,
        campaign_id: jobData.campaign_id,
        group_id: jobData.group_id,
        progress_group_id: jobData.progress_group_id,
        video_id: jobData.video_id,
      });
    }

    return {
      caption: jobData.caption_id ? { id: jobData.caption_id } : null,
      generated: Boolean(jobData.caption_generated),
      text: jobData.legenda || "",
    };
  }

  const selected = await videoCaptionsService.selectCaptionForVideo(jobData.video_id, {
    transcript,
    requireCaptionReview: true,
    campaign_id: jobData.campaign_id,
    group_id: jobData.group_id,
    progress_group_id: jobData.progress_group_id,
  });

  if (selected && selected.text) {
    logger.info &&
      logger.info(
        JSON.stringify({
          event: "dispatch.caption.prepared",
          campaign_id: jobData.campaign_id,
          group_id: jobData.group_id,
          progress_group_id: jobData.progress_group_id,
          video_id: jobData.video_id,
          caption_id: selected.caption && selected.caption.id,
          generated: Boolean(selected.generated),
        })
      );

    return selected;
  }

  if (captionReviewService && typeof captionReviewService.assertCaptionApproved === "function") {
    await captionReviewService.assertCaptionApproved({
      caption: jobData.legenda,
      transcript,
      campaign_id: jobData.campaign_id,
      group_id: jobData.group_id,
      progress_group_id: jobData.progress_group_id,
      video_id: jobData.video_id,
    });
  }

  return {
    caption: jobData.caption_id ? { id: jobData.caption_id } : null,
    generated: Boolean(jobData.caption_generated),
    text: jobData.legenda || "",
  };
}

async function markDispatchCaptionUsed(params = {}) {
  const { captionSelection, jobData, logger = console, usedAt = new Date(), videoCaptionsService } = params;
  const captionId = captionSelection?.caption?.id || jobData?.caption_id;

  if (!captionId || !videoCaptionsService || typeof videoCaptionsService.markCaptionUsed !== "function") {
    return null;
  }

  const marked = await videoCaptionsService.markCaptionUsed(captionId, { usedAt });

  logger.info &&
    logger.info(
      JSON.stringify({
        event: "dispatch.caption.marked_used",
        campaign_id: jobData && jobData.campaign_id,
        group_id: jobData && jobData.group_id,
        progress_group_id: jobData && jobData.progress_group_id,
        video_id: jobData && jobData.video_id,
        caption_id: captionId,
        used_at: usedAt.toISOString(),
      })
    );

  return marked;
}

// Sobra reservada para o resto do JSON do sendMedia (number, mediatype, mimetype,
// fileName e a legenda) alem do campo `media` em base64.

module.exports = {
  markDispatchCaptionUsed,
  prepareDispatchCaptionBeforeQueue,
  resolveDispatchCaption,
  resolveVideoTranscript,
};
