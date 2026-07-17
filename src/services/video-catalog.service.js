const videoCatalogRepository = require("../repositories/video-catalog.repository");

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
    getFirstApprovedByProfileAndTrail,
    update,
  };
}

module.exports = createVideoCatalogService();
module.exports.createVideoCatalogService = createVideoCatalogService;
module.exports.normalizeStatus = normalizeStatus;
