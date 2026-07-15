const groupVideoProgressRepository = require("../repositories/group-video-progress.repository");
const groupsRepository = require("../repositories/groups.repository");
const videoCatalogRepository = require("../repositories/video-catalog.repository");

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

  return {
    getLastVideo,
    hasDuplicate,
    listDelivered,
    recordDelivery,
  };
}

module.exports = createGroupVideoProgressService();
module.exports.createGroupVideoProgressService = createGroupVideoProgressService;
