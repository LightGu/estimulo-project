const assert = require("node:assert/strict");

const { createDispatchConsistencyService } = require("../src/services/dispatch-consistency.service");

async function main() {
  const createdLogs = [];
  const createdProgress = [];
  const campaignUpdates = [];
  const operationOrder = [];

  const dispatchLogsRepository = {
    createLog: async (payload) => {
      const record = { id: `log-${createdLogs.length + 1}`, ...payload };
      createdLogs.push(record);
      return record;
    },
    updateStatus: async (id, status, mensagemErro = null) => {
      operationOrder.push(`log:${status}`);
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
      operationOrder.push("progress:register");
      const record = { id: `progress-${createdProgress.length + 1}`, ...payload };
      createdProgress.push(record);
      return record;
    },
  };

  const campaignsRepository = {
    findById: async (id) => (id === "campaign-1" ? { id, nome: "Campanha" } : null),
    update: async (id, payload) => {
      campaignUpdates.push({ id, payload });
      return { id, ...payload };
    },
  };

  const groupsRepository = {
    findById: async (id) => (id === "group-1" ? { id, nome: "Grupo" } : null),
  };

  const videoCatalogRepository = {
    findById: async (id) => (["video-1", "video-2"].includes(id) ? { id, drive_file_id: "drive-1" } : null),
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
  assert.ok(operationOrder.indexOf("log:enviado") < operationOrder.indexOf("progress:register"));
  assert.equal(campaignUpdates.length, 0);

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

  const sendFailure = await service.executeDispatch({
    campaignId: "campaign-1",
    groupId: "group-1",
    videoId: "video-2",
    sender: async () => {
      throw new Error("Falha no provedor");
    },
    deliveryPayload: { message: "erro" },
  }).catch((error) => error);

  assert.equal(sendFailure.message, "Falha no provedor");
  const failedLog = createdLogs.find((entry) => entry.video_id === "video-2");
  assert.equal(failedLog.status, "erro");
  assert.equal(failedLog.mensagem_erro, "Falha no provedor");
  assert.equal(createdProgress.length, 1);
  assert.deepEqual(campaignUpdates.at(-1), { id: "campaign-1", payload: { ativo: false } });

  const unconfirmedSend = await service.executeDispatch({
    campaignId: "campaign-1",
    groupId: "group-1",
    videoId: "video-2",
    sender: async () => ({ provider: "fake", status: 500, data: { message: "Erro no servidor" } }),
    deliveryPayload: { message: "erro" },
  }).catch((error) => error);

  assert.match(unconfirmedSend.message, /status 500/);
  assert.equal(createdProgress.length, 1);

  console.log("integration-dispatch-flow tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
