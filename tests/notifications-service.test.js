const assert = require("node:assert/strict");

const { createNotificationsService } = require("../src/services/notifications.service");

function createSettingsServiceStub(overrides = {}) {
  return {
    getNotificationSettings: async () => ({
      notification_group_id: "group-1",
      notification_group_name: "Equipe Estimulo",
      events: {
        campaignStarted: true,
        campaignFinished: true,
        dispatchFailure: true,
        aiError: true,
      },
      ...overrides,
    }),
  };
}

function createGroupsRepositoryStub(overrides = {}) {
  return {
    findById: async () => ({ id: "group-1", nome: "Equipe Estimulo", evolution_group_id: "120363@g.us" }),
    ...overrides,
  };
}

async function main() {
  // ---------- notifyCampaignStarted sends to resolved group ----------
  {
    const sentPayloads = [];
    const service = createNotificationsService({
      settingsService: createSettingsServiceStub(),
      groupsRepository: createGroupsRepositoryStub(),
      sendToEvolution: async (payload) => {
        sentPayloads.push(payload);
        return { status: 200 };
      },
      logger: {},
    });

    const result = await service.notifyCampaignStarted({
      campaignId: "campaign-1",
      campaignLabel: "Trilha Pre-infancia",
      groupsCount: 3,
    });

    assert.equal(result.sent, true);
    assert.equal(sentPayloads.length, 1);
    assert.equal(sentPayloads[0].groupId, "120363@g.us");
    assert.match(sentPayloads[0].message, /Trilha Pre-infancia/);
    assert.match(sentPayloads[0].message, /3 grupo\(s\)/);
  }

  // ---------- notifyCampaignFinished ----------
  {
    const sentPayloads = [];
    const service = createNotificationsService({
      settingsService: createSettingsServiceStub(),
      groupsRepository: createGroupsRepositoryStub(),
      sendToEvolution: async (payload) => {
        sentPayloads.push(payload);
        return { status: 200 };
      },
      logger: {},
    });

    const result = await service.notifyCampaignFinished({ campaignId: "campaign-1", campaignLabel: "Trilha X" });

    assert.equal(result.sent, true);
    assert.match(sentPayloads[0].message, /Trilha X.*conclu[íi]da/);
  }

  // ---------- notifyDispatchFailure ----------
  {
    const sentPayloads = [];
    const service = createNotificationsService({
      settingsService: createSettingsServiceStub(),
      groupsRepository: createGroupsRepositoryStub(),
      sendToEvolution: async (payload) => {
        sentPayloads.push(payload);
        return { status: 200 };
      },
      logger: {},
    });

    const result = await service.notifyDispatchFailure({
      campaignId: "campaign-1",
      groupId: "group-abc",
      videoId: "video-1",
      errorMessage: "Evolution indisponivel",
    });

    assert.equal(result.sent, true);
    assert.match(sentPayloads[0].message, /Falha no envio/);
    assert.match(sentPayloads[0].message, /group-abc/);
    assert.match(sentPayloads[0].message, /Evolution indisponivel/);
  }

  // ---------- notifyAiError ----------
  {
    const sentPayloads = [];
    const service = createNotificationsService({
      settingsService: createSettingsServiceStub(),
      groupsRepository: createGroupsRepositoryStub(),
      sendToEvolution: async (payload) => {
        sentPayloads.push(payload);
        return { status: 200 };
      },
      logger: {},
    });

    const result = await service.notifyAiError({
      campaignId: "campaign-1",
      groupId: "group-1",
      videoId: "video-1",
      stage: "legenda",
      errorMessage: "Modelo indisponivel",
    });

    assert.equal(result.sent, true);
    assert.match(sentPayloads[0].message, /Erro na IA/);
    assert.match(sentPayloads[0].message, /Modelo indisponivel/);
  }

  // ---------- no group configured: does not call sender ----------
  {
    let senderCalled = false;
    const service = createNotificationsService({
      settingsService: createSettingsServiceStub({ notification_group_id: null }),
      groupsRepository: createGroupsRepositoryStub(),
      sendToEvolution: async () => {
        senderCalled = true;
        return { status: 200 };
      },
      logger: {},
    });

    const result = await service.notifyCampaignStarted({ campaignId: "campaign-1", campaignLabel: "X", groupsCount: 1 });

    assert.equal(result.sent, false);
    assert.equal(result.reason, "no_notification_group_configured");
    assert.equal(senderCalled, false);
  }

  // ---------- group not found: does not call sender ----------
  {
    let senderCalled = false;
    const service = createNotificationsService({
      settingsService: createSettingsServiceStub(),
      groupsRepository: createGroupsRepositoryStub({ findById: async () => null }),
      sendToEvolution: async () => {
        senderCalled = true;
        return { status: 200 };
      },
      logger: {},
    });

    const result = await service.notifyCampaignStarted({ campaignId: "campaign-1", campaignLabel: "X", groupsCount: 1 });

    assert.equal(result.sent, false);
    assert.equal(result.reason, "no_notification_group_configured");
    assert.equal(senderCalled, false);
  }

  // ---------- sender rejects: resolves without throwing ----------
  {
    const service = createNotificationsService({
      settingsService: createSettingsServiceStub(),
      groupsRepository: createGroupsRepositoryStub(),
      sendToEvolution: async () => {
        throw new Error("Evolution API fora do ar");
      },
      logger: {},
    });

    const result = await service.notifyDispatchFailure({
      campaignId: "campaign-1",
      groupId: "group-1",
      videoId: "video-1",
      errorMessage: "erro original",
    });

    assert.equal(result.sent, false);
    assert.equal(result.reason, "send_failed");
    assert.equal(result.error_message, "Evolution API fora do ar");
  }

  // ---------- event disabled: does not call sender ----------
  {
    let senderCalled = false;
    const service = createNotificationsService({
      settingsService: createSettingsServiceStub({
        events: { campaignStarted: false, campaignFinished: true, dispatchFailure: true, aiError: true },
      }),
      groupsRepository: createGroupsRepositoryStub(),
      sendToEvolution: async () => {
        senderCalled = true;
        return { status: 200 };
      },
      logger: {},
    });

    const result = await service.notifyCampaignStarted({ campaignId: "campaign-1", campaignLabel: "X", groupsCount: 1 });

    assert.equal(result.sent, false);
    assert.equal(result.reason, "event_disabled");
    assert.equal(senderCalled, false);
  }

  console.log("notifications service tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
