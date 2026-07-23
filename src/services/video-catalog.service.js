const videoCatalogRepository = require("../repositories/video-catalog.repository");
const videoTranscriptionService = require("./video-transcription.service");

function normalizeStatus(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (["true", "1", "sim", "aprovado"].includes(normalized)) {
      return true;
    }

    if (["false", "0", "nao", "não", "pendente_revisao", "reprovado", "inativo"].includes(normalized)) {
      return false;
    }
  }

  throw new Error("Invalid status");
}

function createVideoCatalogService(dependencies = {}) {
  const repository = dependencies.repository || videoCatalogRepository;
  const transcriptionService =
    dependencies.transcriptionService ||
    videoTranscriptionService.createVideoTranscriptionService({
      repository,
      ...(dependencies.videoTranscription || {}),
    });

  async function create(payload) {
    const driveFileId = payload?.drive_file_id?.trim();
    const etapa = Number(payload?.etapa);
    const status = normalizeStatus(payload?.status, false);

    if (!driveFileId) {
      throw new Error("Drive file id is required");
    }

    if (!Number.isInteger(etapa) || etapa < 1) {
      throw new Error("Etapa must be a positive integer");
    }

    const existingVideo = await repository.findByDriveFileId(driveFileId);

    if (existingVideo) {
      throw new Error("Drive file id already exists");
    }

    const normalizedPayload = { ...payload, drive_file_id: driveFileId, etapa, status };

    return repository.create(normalizedPayload);
  }

  async function update(id, payload) {
    if (!id) {
      throw new Error("Video id is required");
    }

    if (!payload || Object.keys(payload).length === 0) {
      throw new Error("At least one field is required");
    }

    const current = await repository.findById(id);

    if (!current) {
      throw new Error("Video not found");
    }

    const nextPayload = { ...payload };

    if (nextPayload.drive_file_id !== undefined) {
      nextPayload.drive_file_id = nextPayload.drive_file_id.trim();

      if (!nextPayload.drive_file_id) {
        throw new Error("Drive file id is required");
      }

      const existingVideo = await repository.findByDriveFileId(nextPayload.drive_file_id);

      if (existingVideo && existingVideo.id !== id) {
        throw new Error("Drive file id already exists");
      }
    }

    if (nextPayload.etapa !== undefined) {
      nextPayload.etapa = Number(nextPayload.etapa);

      if (!Number.isInteger(nextPayload.etapa) || nextPayload.etapa < 1) {
        throw new Error("Etapa must be a positive integer");
      }
    }

    if (nextPayload.status !== undefined) {
      nextPayload.status = normalizeStatus(nextPayload.status);
    }

    return repository.update(id, nextPayload);
  }

  async function remove(id) {
    if (!id) {
      throw new Error("Video id is required");
    }

    const current = await repository.findById(id);

    if (!current) {
      throw new Error("Video not found");
    }

    return repository.delete(id);
  }

  async function getById(id) {
    if (!id) {
      throw new Error("Video id is required");
    }

    return repository.findById(id);
  }

  async function list() {
    return repository.findAll();
  }

  async function listApproved() {
    return repository.listApproved();
  }

  async function listBySegmento(trilhaSegmento) {
    if (!trilhaSegmento) {
      throw new Error("Segment is required");
    }

    return repository.listBySegmento(trilhaSegmento);
  }

  async function listByEtapa(etapa) {
    if (!Number.isInteger(Number(etapa)) || Number(etapa) < 1) {
      throw new Error("Etapa must be a positive integer");
    }

    return repository.listByEtapa(Number(etapa));
  }

  async function listByStatus(status) {
    if (status === undefined || status === null || status === "") {
      throw new Error("Status is required");
    }

    return repository.listByStatus(normalizeStatus(status));
  }

  async function listTrailsByProfile(profile) {
    if (!profile) {
      throw new Error("Profile is required");
    }

    return repository.listTrailsByProfile(profile);
  }

  async function listTrailsOverview() {
    return repository.listTrailsOverview();
  }

  async function listUnclassified() {
    return repository.listUnclassified();
  }

  async function createTrailVideos(payload) {
    const perfilDaJornada = String(payload?.perfil_da_jornada || "").trim();
    const macrotema = String(payload?.macrotema || "").trim();
    const trilha = String(payload?.trilha || "").trim();
    const videoIds = Array.isArray(payload?.video_ids)
      ? payload.video_ids.map((id) => String(id || "").trim()).filter(Boolean)
      : [];

    if (!perfilDaJornada) {
      throw new Error("Perfil da jornada is required");
    }

    if (!macrotema) {
      throw new Error("Macrotema is required");
    }

    if (!trilha) {
      throw new Error("Trilha is required");
    }

    if (!videoIds.length) {
      throw new Error("At least one video_id is required");
    }

    const existingVideos = await repository.findAll();
    const trailVideos = existingVideos.filter(
      (video) => video.perfil_da_jornada === perfilDaJornada && video.macrotema === macrotema && video.trilha === trilha
    );
    const maxOrdemGeral = existingVideos.reduce((max, video) => Math.max(max, Number(video.ordem_geral) || 0), 0);
    const maxOrdem = trailVideos.reduce((max, video) => Math.max(max, Number(video.ordem) || 0), 0);

    const updated = [];

    for (let index = 0; index < videoIds.length; index += 1) {
      const current = await repository.findById(videoIds[index]);

      if (!current) {
        throw new Error("Video not found");
      }

      const video = await repository.update(videoIds[index], {
        perfil_da_jornada: perfilDaJornada,
        macrotema,
        trilha,
        ordem: maxOrdem + index + 1,
        ordem_geral: maxOrdemGeral + index + 1,
      });

      updated.push(video);
    }

    return updated;
  }

  async function moveVideoTrail(id, payload) {
    if (!id) {
      throw new Error("Video id is required");
    }

    const perfilDaJornada = String(payload?.perfil_da_jornada || "").trim();
    const macrotema = String(payload?.macrotema || "").trim();
    const trilha = String(payload?.trilha || "").trim();

    if (!perfilDaJornada) {
      throw new Error("Perfil da jornada is required");
    }

    if (!macrotema) {
      throw new Error("Macrotema is required");
    }

    if (!trilha) {
      throw new Error("Trilha is required");
    }

    const current = await repository.findById(id);

    if (!current) {
      throw new Error("Video not found");
    }

    const existingVideos = await repository.findAll();
    const destinationVideos = existingVideos.filter(
      (video) =>
        video.id !== id &&
        video.perfil_da_jornada === perfilDaJornada &&
        video.macrotema === macrotema &&
        video.trilha === trilha
    );
    const maxOrdem = destinationVideos.reduce((max, video) => Math.max(max, Number(video.ordem) || 0), 0);
    const maxOrdemGeral = existingVideos.reduce((max, video) => Math.max(max, Number(video.ordem_geral) || 0), 0);

    return repository.update(id, {
      perfil_da_jornada: perfilDaJornada,
      macrotema,
      trilha,
      ordem: maxOrdem + 1,
      ordem_geral: maxOrdemGeral + 1,
    });
  }

  async function reorderTrailVideos(orderedIds) {
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      throw new Error("orderedIds is required");
    }

    return repository.reorderWithinTrail(orderedIds);
  }

  async function getFirstApprovedByProfileAndTrail(profile, trail) {
    if (!profile) {
      throw new Error("Profile is required");
    }

    if (!trail) {
      throw new Error("Trail is required");
    }

    return repository.findFirstApprovedByProfileAndTrail(profile, trail);
  }

  async function getByDriveFileId(driveFileId) {
    if (!driveFileId) {
      throw new Error("Drive file id is required");
    }

    return repository.findByDriveFileId(driveFileId);
  }

  async function transcribeById(id, options = {}) {
    if (!id) {
      throw new Error("Video id is required");
    }

    return transcriptionService.transcribeById(id, options);
  }

  async function transcribeByDriveFileId(driveFileId, options = {}) {
    if (!driveFileId) {
      throw new Error("Drive file id is required");
    }

    return transcriptionService.transcribeByDriveFileId(driveFileId, options);
  }

  return {
    create,
    delete: remove,
    getByDriveFileId,
    getById,
    list,
    listApproved,
    listByEtapa,
    listBySegmento,
    listByStatus,
    listTrailsByProfile,
    listTrailsOverview,
    listUnclassified,
    createTrailVideos,
    moveVideoTrail,
    reorderTrailVideos,
    getFirstApprovedByProfileAndTrail,
    transcribeByDriveFileId,
    transcribeById,
    update,
  };
}

module.exports = createVideoCatalogService();
module.exports.createVideoCatalogService = createVideoCatalogService;
module.exports.normalizeStatus = normalizeStatus;
