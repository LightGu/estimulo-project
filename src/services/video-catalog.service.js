const videoCatalogRepository = require("../repositories/video-catalog.repository");

function createVideoCatalogService(dependencies = {}) {
  const repository = dependencies.repository || videoCatalogRepository;

  async function create(payload) {
    const driveFileId = payload?.drive_file_id?.trim();
    const etapa = Number(payload?.etapa);
    const status = payload?.status || "pendente_revisao";

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

    const validStatuses = ["pendente_revisao", "aprovado", "reprovado", "inativo"];

    if (!validStatuses.includes(status)) {
      throw new Error("Invalid status");
    }

    const normalizedPayload = { ...payload, drive_file_id: driveFileId, etapa, status };

    if (status === "aprovado" && !normalizedPayload.data_aprovacao) {
      normalizedPayload.data_aprovacao = new Date().toISOString();
    }

    if (status !== "aprovado") {
      normalizedPayload.data_aprovacao = null;
    }

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
      const validStatuses = ["pendente_revisao", "aprovado", "reprovado", "inativo"];

      if (!validStatuses.includes(nextPayload.status)) {
        throw new Error("Invalid status");
      }

      if (nextPayload.status === "aprovado" && !nextPayload.data_aprovacao) {
        nextPayload.data_aprovacao = new Date().toISOString();
      }

      if (nextPayload.status !== "aprovado") {
        nextPayload.data_aprovacao = null;
      }
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
    if (!status) {
      throw new Error("Status is required");
    }

    return repository.listByStatus(status);
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
    update,
  };
}

module.exports = createVideoCatalogService();
module.exports.createVideoCatalogService = createVideoCatalogService;
