const express = require("express");
const createCampaignsController = require("./controllers/campaigns.controller");
const createGroupsController = require("./controllers/groups.controller");
const createHealthController = require("./controllers/health.controller");
const campaignsService = require("../services/campaigns.service");
const groupsService = require("../services/groups.service");

function createApp(dependencies = {}) {
  const app = express();
  app.use(express.json());

  const campaignService = dependencies.campaignService || campaignsService;
  const groupService = dependencies.groupService || groupsService;
  const campaignsController = createCampaignsController({ campaignService });
  const groupsController = createGroupsController({ groupService });
  const healthController = createHealthController(dependencies.healthController || {});

  app.post("/campaigns", campaignsController);
  app.get("/groups/unclassified", groupsController.listWithoutSegment);
  app.post("/groups/sync", groupsController.syncFromEvolution);
  app.get("/health", healthController);

  return app;
}

module.exports = createApp;
