const trilhasRepository = require("../repositories/trilhas.repository");
const videoCatalogRepository = require("../repositories/video-catalog.repository");
const groupProfilesService = require("./group-profiles.service");
const { normalizePerfis } = require("../domain/trail-profiles");

function createTrilhasService(dependencies = {}) {
  const repository = dependencies.repository || trilhasRepository;
  const videoRepository = dependencies.videoCatalogRepository || videoCatalogRepository;
  const profilesService = dependencies.groupProfilesService || groupProfilesService;

  async function listValidPerfilNames() {
    const profiles = await profilesService.list();

    return profiles.map((profile) => profile.nome);
  }

  async function requireTrilha(trilhaId) {
    const trimmed = String(trilhaId || "").trim();

    if (!trimmed) {
      throw new Error("Trilha id is required");
    }

    const trilha = await repository.findById(trimmed);

    if (!trilha) {
      throw new Error("Trilha not found");
    }

    return trilha;
  }

  async function requireVideo(videoId) {
    const trimmed = String(videoId || "").trim();

    if (!trimmed) {
      throw new Error("Video id is required");
    }

    const video = await videoRepository.findById(trimmed);

    if (!video) {
      throw new Error("Video not found");
    }

    return video;
  }

  async function buildOverview(trilhas) {
    const trilhaIds = trilhas.map((trilha) => trilha.id);

    if (!trilhaIds.length) {
      return [];
    }

    const [videoLinks, trailPerfis, allVideos] = await Promise.all([
      repository.listAllVideoLinks(),
      repository.listAllTrailPerfis(),
      videoRepository.findAll(),
    ]);

    const videosById = new Map(allVideos.map((video) => [video.id, video]));
    const linksByTrilha = new Map();

    videoLinks.forEach((link) => {
      const current = linksByTrilha.get(link.trilha_id) || [];
      current.push(link);
      linksByTrilha.set(link.trilha_id, current);
    });

    const perfisByTrilha = new Map();
    trailPerfis.forEach((entry) => {
      const current = perfisByTrilha.get(entry.trilha_id) || [];
      current.push(entry.perfil);
      perfisByTrilha.set(entry.trilha_id, current);
    });

    return trilhas
      .map((trilha) => {
        const links = (linksByTrilha.get(trilha.id) || []).sort((left, right) => (left.ordem ?? 0) - (right.ordem ?? 0));
        const videos = links
          .map((link) => {
            const video = videosById.get(link.video_id);
            return video ? { ...video, ordem: link.ordem } : null;
          })
          .filter(Boolean);

        return {
          id: trilha.id,
          macrotema: trilha.macrotema,
          trilha: trilha.trilha,
          perfis: perfisByTrilha.get(trilha.id) || [],
          videos,
        };
      })
      .sort((left, right) => {
        if (left.macrotema !== right.macrotema) {
          return left.macrotema.localeCompare(right.macrotema);
        }

        return left.trilha.localeCompare(right.trilha);
      });
  }

  async function listAll() {
    return repository.listAll();
  }

  async function listOverview() {
    const trilhas = await repository.listAll();

    return buildOverview(trilhas);
  }

  async function listByPerfil(perfil) {
    const [normalizedPerfil] = normalizePerfis([perfil]);
    const trilhas = await repository.listTrilhasByPerfil(normalizedPerfil);
    const overview = await buildOverview(trilhas);

    return overview.map((trilha) => ({
      id: trilha.id,
      macrotema: trilha.macrotema,
      trilha: trilha.trilha,
      videos_count: trilha.videos.length,
      first_video: trilha.videos[0] || null,
    }));
  }

  async function listSelectableVideos() {
    const [allVideos, trilhas] = await Promise.all([
      videoRepository.findAll(),
      repository.listAll(),
    ]);

    const trilhasById = new Map(trilhas.map((trilha) => [trilha.id, trilha]));
    const links = await repository.listAllVideoLinks();

    const trilhasByVideo = new Map();
    links.forEach((link) => {
      const trilha = trilhasById.get(link.trilha_id);

      if (!trilha) {
        return;
      }

      const current = trilhasByVideo.get(link.video_id) || [];
      current.push({ id: trilha.id, macrotema: trilha.macrotema, trilha: trilha.trilha });
      trilhasByVideo.set(link.video_id, current);
    });

    return allVideos.map((video) => ({
      ...video,
      trilhas: trilhasByVideo.get(video.id) || [],
    }));
  }

  async function createTrilha(payload) {
    const macrotema = String(payload?.macrotema || "").trim();
    const trilha = String(payload?.trilha || "").trim();
    const videoIds = Array.isArray(payload?.video_ids)
      ? payload.video_ids.map((id) => String(id || "").trim()).filter(Boolean)
      : [];
    const validPerfis = await listValidPerfilNames();
    const perfis = normalizePerfis(payload?.perfis !== undefined ? payload.perfis : [payload?.perfil_da_jornada], {
      validPerfis,
    });

    if (!macrotema) {
      throw new Error("Macrotema is required");
    }

    if (!trilha) {
      throw new Error("Trilha is required");
    }

    if (!videoIds.length) {
      throw new Error("At least one video_id is required");
    }

    const existingTrilha = await repository.findByMacrotemaTrilha(macrotema, trilha);

    if (existingTrilha) {
      throw new Error("Trilha already exists");
    }

    for (const videoId of videoIds) {
      await requireVideo(videoId);
    }

    const createdTrilha = await repository.create({ macrotema, trilha });

    await repository.setTrailPerfis(createdTrilha.id, perfis);

    for (let index = 0; index < videoIds.length; index += 1) {
      await repository.addVideo(createdTrilha.id, videoIds[index], index + 1);
    }

    const [overview] = await buildOverview([createdTrilha]);

    return overview;
  }

  async function addVideoToTrilha(trilhaId, videoId) {
    const trilha = await requireTrilha(trilhaId);
    await requireVideo(videoId);

    const existingLink = await repository.findVideoLink(trilha.id, videoId);

    if (existingLink) {
      throw new Error("Video already in trilha");
    }

    const links = await repository.listVideoLinksByTrilha(trilha.id);
    const maxOrdem = links.reduce((max, link) => Math.max(max, Number(link.ordem) || 0), 0);

    return repository.addVideo(trilha.id, videoId, maxOrdem + 1);
  }

  async function removeVideoFromTrilha(trilhaId, videoId) {
    const trilha = await requireTrilha(trilhaId);

    const existingLink = await repository.findVideoLink(trilha.id, videoId);

    if (!existingLink) {
      throw new Error("Video not in trilha");
    }

    return repository.removeVideo(trilha.id, videoId);
  }

  async function moveVideoBetweenTrilhas(videoId, payload) {
    await requireVideo(videoId);
    const toTrilhaId = String(payload?.to_trilha_id || "").trim();

    if (!toTrilhaId) {
      throw new Error("Destination trilha id is required");
    }

    await requireTrilha(toTrilhaId);
    const fromTrilhaId = payload?.from_trilha_id ? String(payload.from_trilha_id).trim() : null;

    if (fromTrilhaId) {
      await requireTrilha(fromTrilhaId);

      const existingLink = await repository.findVideoLink(fromTrilhaId, videoId);

      if (existingLink) {
        await repository.removeVideo(fromTrilhaId, videoId);
      }
    }

    const destinationLink = await repository.findVideoLink(toTrilhaId, videoId);

    if (destinationLink) {
      throw new Error("Video already in trilha");
    }

    const links = await repository.listVideoLinksByTrilha(toTrilhaId);
    const maxOrdem = links.reduce((max, link) => Math.max(max, Number(link.ordem) || 0), 0);

    return repository.addVideo(toTrilhaId, videoId, maxOrdem + 1);
  }

  async function reorderTrilhaVideos(trilhaId, orderedVideoIds) {
    const trilha = await requireTrilha(trilhaId);

    if (!Array.isArray(orderedVideoIds) || orderedVideoIds.length === 0) {
      throw new Error("orderedVideoIds is required");
    }

    return repository.reorderVideosWithinTrilha(trilha.id, orderedVideoIds);
  }

  async function renameTrilha(trilhaId, payload) {
    const trilha = await requireTrilha(trilhaId);
    const nextPayload = {};

    if (payload?.macrotema !== undefined) {
      const macrotema = String(payload.macrotema || "").trim();

      if (!macrotema) {
        throw new Error("Macrotema is required");
      }

      nextPayload.macrotema = macrotema;
    }

    if (payload?.trilha !== undefined) {
      const trilhaNome = String(payload.trilha || "").trim();

      if (!trilhaNome) {
        throw new Error("Trilha is required");
      }

      nextPayload.trilha = trilhaNome;
    }

    if (!Object.keys(nextPayload).length) {
      throw new Error("At least one field is required");
    }

    const macrotema = nextPayload.macrotema ?? trilha.macrotema;
    const trilhaNome = nextPayload.trilha ?? trilha.trilha;

    const existingTrilha = await repository.findByMacrotemaTrilha(macrotema, trilhaNome);

    if (existingTrilha && existingTrilha.id !== trilha.id) {
      throw new Error("Trilha already exists");
    }

    return repository.rename(trilha.id, nextPayload);
  }

  async function removeTrilha(trilhaId) {
    const trilha = await requireTrilha(trilhaId);

    return repository.remove(trilha.id);
  }

  async function updateTrailPerfis(trilhaId, perfis) {
    const trilha = await requireTrilha(trilhaId);
    const validPerfis = await listValidPerfilNames();
    const normalizedPerfis = normalizePerfis(perfis, { validPerfis });

    await repository.setTrailPerfis(trilha.id, normalizedPerfis);

    return normalizedPerfis;
  }

  async function getFirstApprovedByProfileAndTrilha(profile, trilhaId) {
    if (!profile) {
      throw new Error("Profile is required");
    }

    const trilha = await requireTrilha(trilhaId);

    // Perfil elegivel para a trilha vem de trilha_perfis, nao de video_catalog.perfil_da_jornada
    // (coluna de texto legada) - ver trilhas.repository.js::findFirstApprovedVideoByTrilhaAndProfile.
    return repository.findFirstApprovedVideoByTrilhaAndProfile(trilha.id, profile);
  }

  return {
    listAll,
    listOverview,
    listByPerfil,
    listSelectableVideos,
    createTrilha,
    addVideoToTrilha,
    removeVideoFromTrilha,
    moveVideoBetweenTrilhas,
    reorderTrilhaVideos,
    renameTrilha,
    removeTrilha,
    updateTrailPerfis,
    getFirstApprovedByProfileAndTrilha,
  };
}

module.exports = createTrilhasService();
module.exports.createTrilhasService = createTrilhasService;
