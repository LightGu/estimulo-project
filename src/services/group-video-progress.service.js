const groupVideoProgressRepository = require("../repositories/group-video-progress.repository");
const groupsRepository = require("../repositories/groups.repository");
const videoCatalogRepository = require("../repositories/video-catalog.repository");
const { resolveGroupTrail, selectNextApprovedUnsentVideo } = require("./group-video-flow");

function normalizeComparableText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

function extractVideoFromDelivery(delivery) {
  return delivery.video_catalog || delivery.video || {};
}

function buildTrailStatus(trail, approvedVideos, deliveries) {
  const trailVideos = approvedVideos.filter(
    (video) => normalizeComparableText(video.trilha || video.trilha_segmento) === normalizeComparableText(trail)
  );
  const deliveredByVideoId = new Map(deliveries.map((delivery) => [delivery.video_id, delivery.enviado_em]));
  const sentVideoIds = deliveries.map((delivery) => delivery.video_id);
  const nextVideo = selectNextApprovedUnsentVideo({
    group: { trilha_override: trail },
    sentVideoIds,
    videos: trailVideos,
  });

  const rows = trailVideos
    .sort((left, right) => Number(left.ordem_geral || left.ordem || 0) - Number(right.ordem_geral || right.ordem || 0))
    .map((video) => {
      if (deliveredByVideoId.has(video.id)) {
        return { ...video, status: "enviado", enviado_em: deliveredByVideoId.get(video.id) };
      }

      if (nextVideo && video.id === nextVideo.id) {
        return { ...video, status: "proximo", enviado_em: null };
      }

      return { ...video, status: "pendente", enviado_em: null };
    });

  const enviados = rows.filter((row) => row.status === "enviado").length;

  return {
    trilha: trail,
    total: rows.length,
    enviados,
    concluida: rows.length > 0 && enviados >= rows.length,
    next_video: nextVideo || null,
    rows,
  };
}

function createGroupVideoProgressService(dependencies = {}) {
  const repository = dependencies.repository || groupVideoProgressRepository;
  const groupsRepositoryDependency = dependencies.groupsRepository || groupsRepository;
  const videoCatalogRepositoryDependency = dependencies.videoCatalogRepository || videoCatalogRepository;

  async function recordDelivery(payload) {
    const groupId = payload?.group_id;
    const videoId = payload?.video_id;

    if (!groupId) {
      throw new Error("Group id is required");
    }

    if (!videoId) {
      throw new Error("Video id is required");
    }

    const group = await groupsRepositoryDependency.findById(groupId);
    const video = await videoCatalogRepositoryDependency.findById(videoId);

    if (!group) {
      throw new Error("Group not found");
    }

    if (!video) {
      throw new Error("Video not found");
    }

    const duplicate = await repository.hasDuplicate(groupId, videoId);

    if (duplicate) {
      throw new Error("Delivery already registered");
    }

    return repository.registerDelivery(payload);
  }

  async function listDelivered(groupId) {
    if (!groupId) {
      throw new Error("Group id is required");
    }

    return repository.listDelivered(groupId);
  }

  async function getLastVideo(groupId) {
    if (!groupId) {
      throw new Error("Group id is required");
    }

    return repository.getLastVideo(groupId);
  }

  async function hasDuplicate(groupId, videoId) {
    if (!groupId) {
      throw new Error("Group id is required");
    }

    if (!videoId) {
      throw new Error("Video id is required");
    }

    return repository.hasDuplicate(groupId, videoId);
  }

  async function getGroupProgressSummary(groupId, group) {
    if (!groupId) {
      throw new Error("Group id is required");
    }

    const resolvedGroup = group || (await groupsRepositoryDependency.findById(groupId));

    if (!resolvedGroup) {
      throw new Error("Group not found");
    }

    const [deliveries, approvedVideos] = await Promise.all([
      repository.listDeliveredWithVideo(groupId),
      videoCatalogRepositoryDependency.listApproved(),
    ]);

    const deliveriesWithTrail = deliveries.map((delivery) => {
      const video = extractVideoFromDelivery(delivery);
      return {
        video_id: delivery.video_id,
        enviado_em: delivery.enviado_em,
        trilha: video.trilha || video.trilha_segmento || null,
        perfil_da_jornada: video.perfil_da_jornada || null,
        nome_do_arquivo: video.nome_do_arquivo || null,
      };
    });

    const currentTrail = resolveGroupTrail(resolvedGroup);
    const historyTrails = [...new Set(deliveriesWithTrail.map((d) => d.trilha).filter(Boolean))];

    const history = historyTrails
      .map((trilha) => {
        const trailDeliveries = deliveriesWithTrail.filter((d) => d.trilha === trilha);
        const status = buildTrailStatus(trilha, approvedVideos, trailDeliveries);
        const dates = trailDeliveries.map((d) => d.enviado_em).sort();

        return {
          trilha,
          enviados: status.enviados,
          total: status.total,
          concluida: status.concluida,
          ultima_atividade: dates[dates.length - 1] || null,
        };
      })
      .sort((left, right) => (left.ultima_atividade < right.ultima_atividade ? 1 : -1));

    let current = null;

    if (currentTrail) {
      const currentDeliveries = deliveriesWithTrail.filter((d) => d.trilha === currentTrail);
      current = buildTrailStatus(currentTrail, approvedVideos, currentDeliveries);
    }

    return { current, history };
  }

  return {
    getGroupProgressSummary,
    getLastVideo,
    hasDuplicate,
    listDelivered,
    recordDelivery,
  };
}

module.exports = createGroupVideoProgressService();
module.exports.createGroupVideoProgressService = createGroupVideoProgressService;
