const assert = require("node:assert/strict");

const { createDispatchConsistencyService } = require("../src/services/dispatch-consistency.service");

async function main() {
  const createdLogs = [];
  const createdProgress = [];

  const dispatchLogsRepository = {
    createLog: async (payload) => {
      const record = { id: `log-${createdLogs.length + 1}`, ...payload };
      createdLogs.push(record);
      return record;
    },
    updateStatus: async (id, status, mensagemErro = null) => {
      const record = createdLogs.find((entry) => entry.id === id);
      if (record) {
        record.status = status;
        record.mensagem_erro = mensagemErro;
      }
      return record;
    },
    listByCampaign: async () => createdLogs,
  };

  const groupVideoProgressRepository = {
    hasDuplicate: async () => false,
    registerDelivery: async (payload) => {
      const record = { id: `progress-${createdProgress.length + 1}`, ...payload };
      createdProgress.push(record);
      return record;
    },
  };

  const campaignsRepository = {
    findById: async (id) => (id === "campaign-1" ? { id, nome: "Campanha" } : null),
  };

  const groupsRepository = {
    findById: async (id) => (id === "group-1" ? { id, nome: "Grupo" } : null),
  };

  const videoCatalogRepository = {
    findById: async (id) => (id === "video-1" ? { id, drive_file_id: "drive-1" } : null),
  };

  const service = createDispatchConsistencyService({
    dispatchLogsRepository,
    groupVideoProgressRepository,
    campaignsRepository,
    groupsRepository,
    videoCatalogRepository,
  });

  const firstRun = await service.executeDispatch({
    campaignId: "campaign-1",
    groupId: "group-1",
    videoId: "video-1",
    sender: async () => ({ ok: true }),
    deliveryPayload: { message: "ok" },
  });

  assert.equal(firstRun.status, "enviado");
  assert.equal(firstRun.logId, "log-1");
  assert.equal(createdProgress.length, 1);
  assert.equal(createdLogs[0].status, "enviado");

  const secondRun = await service.executeDispatch({
    campaignId: "campaign-1",
    groupId: "group-1",
    videoId: "video-1",
    sender: async () => ({ ok: true }),
    deliveryPayload: { message: "ok" },
  });

  assert.equal(secondRun.idempotent, true);
  assert.equal(secondRun.skippedSend, true);
  assert.equal(createdProgress.length, 1);

  const failureRun = await service.executeDispatch({
    campaignId: "campaign-1",
    groupId: "group-2",
    videoId: "video-1",
    sender: async () => {
      throw new Error("Falha simulada");
    },
    deliveryPayload: { message: "ok" },
  }).catch((error) => error);

  assert.equal(failureRun.message, "Group not found");

  console.log("integration-dispatch-flow tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
