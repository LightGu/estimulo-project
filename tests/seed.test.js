const assert = require("node:assert/strict");

const { createDispatchConsistencyService } = require("../src/services/dispatch-consistency.service");

async function main() {
  const repository = {
    createLog: async (payload) => ({ id: "log-1", ...payload }),
    updateStatus: async () => ({ id: "log-1" }),
    listByCampaign: async () => [{ id: "log-1", group_id: "group-1", video_id: "video-1", status: "enviado" }],
  };
  const progressRepository = {
    hasDuplicate: async () => true,
    registerDelivery: async () => ({ id: "progress-1" }),
  };
  const service = createDispatchConsistencyService({
    dispatchLogsRepository: repository,
    groupVideoProgressRepository: progressRepository,
    campaignsRepository: { findById: async () => ({ id: "campaign-1" }) },
    groupsRepository: { findById: async () => ({ id: "group-1" }) },
    videoCatalogRepository: { findById: async () => ({ id: "video-1" }) },
  });

  const result = await service.executeDispatch({
    campaignId: "campaign-1",
    groupId: "group-1",
    videoId: "video-1",
    sender: async () => ({ ok: true }),
    deliveryPayload: { message: "ok" },
  });

  assert.equal(result.idempotent, true);
  assert.equal(result.status, "enviado");
  console.log("seed tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
