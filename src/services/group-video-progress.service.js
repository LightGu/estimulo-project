const groupVideoProgressRepository = require("../repositories/group-video-progress.repository");
const groupsRepository = require("../repositories/groups.repository");
const trilhasRepository = require("../repositories/trilhas.repository");
const videoCatalogRepository = require("../repositories/video-catalog.repository");
const { resolveGroupTrailId, selectNextApprovedUnsentVideo } = require("./group-video-flow");

function extractVideoFromDelivery(delivery) {
  return delivery.video_catalog || delivery.video || {};
}

async function buildTrailStatusById(trilhaId, deliveries, trilhasRepositoryDependency, videoCatalogRepositoryDependency) {
  const [trilha, links] = await Promise.all([
    trilhasRepositoryDependency.findById(trilhaId),
    trilhasRepositoryDependency.listVideoLinksByTrilha(trilhaId),
  ]);
  const videoIds = links.map((link) => link.video_id);

  const approvedVideos = videoIds.length
    ? (await videoCatalogRepositoryDependency.listApproved()).filter((video) => videoIds.includes(video.id))
    : [];
  const ordemByVideoId = new Map(links.map((link) => [link.video_id, link.ordem]));
  const trailVideos = approvedVideos.map((video) => ({ ...video, ordem: ordemByVideoId.get(video.id) }));

  const deliveredByVideoId = new Map(deliveries.map((delivery) => [delivery.video_id, delivery.enviado_em]));
  const sentVideoIds = deliveries.map((delivery) => delivery.video_id);
  const nextVideo = selectNextApprovedUnsentVideo({
    group: { trilha_id: trilhaId },
    sentVideoIds,
    videos: trailVideos,
  });

  const rows = trailVideos
    .sort((left, right) => Number(left.ordem ?? Number.MAX_SAFE_INTEGER) - Number(right.ordem ?? Number.MAX_SAFE_INTEGER))
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
    trilha: trilha ? trilha.trilha : null,
    trilha_id: trilhaId,
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
  const trilhasRepositoryDependency = dependencies.trilhasRepository || trilhasRepository;
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

    const deliveries = await repository.listDeliveredWithVideo(groupId);

    const deliveriesWithTrail = deliveries.map((delivery) => {
      const video = extractVideoFromDelivery(delivery);
      return {
        video_id: delivery.video_id,
        enviado_em: delivery.enviado_em,
        trilha_id: delivery.trilha_id || null,
        nome_do_arquivo: video.nome_do_arquivo || null,
      };
    });

    const deliveriesById = deliveriesWithTrail.filter((d) => d.trilha_id);

    const history = await Promise.all(
      [...new Set(deliveriesById.map((d) => d.trilha_id))]
        .map((trilhaId) => {
          const trailDeliveries = deliveriesById.filter((d) => d.trilha_id === trilhaId);
          const dates = trailDeliveries.map((d) => d.enviado_em).sort();

          return { trilha_id: trilhaId, trailDeliveries, ultima_atividade: dates[dates.length - 1] || null };
        })
        .sort((left, right) => (left.ultima_atividade < right.ultima_atividade ? 1 : -1))
        .map(async (entry) => {
          const status = await buildTrailStatusById(
            entry.trilha_id,
            entry.trailDeliveries,
            trilhasRepositoryDependency,
            videoCatalogRepositoryDependency
          );

          return {
            trilha: status.trilha,
            trilha_id: entry.trilha_id,
            enviados: status.enviados,
            total: status.total,
            concluida: status.concluida,
            ultima_atividade: entry.ultima_atividade,
          };
        })
    );

    const currentTrailId = resolveGroupTrailId(resolvedGroup);
    let current = null;

    if (currentTrailId) {
      const currentDeliveries = deliveriesWithTrail.filter((d) => d.trilha_id === currentTrailId);
      current = await buildTrailStatusById(currentTrailId, currentDeliveries, trilhasRepositoryDependency, videoCatalogRepositoryDependency);
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
