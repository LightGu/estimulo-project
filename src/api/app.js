const express = require("express");
const createCampaignsController = require("./controllers/campaigns.controller");
const createHealthController = require("./controllers/health.controller");
const campaignsService = require("../services/campaigns.service");

function createApp(dependencies = {}) {
  const app = express();
  app.use(express.json());

  const campaignService = dependencies.campaignService || campaignsService;
  const campaignsController = createCampaignsController({ campaignService });
  const healthController = createHealthController(dependencies.healthController || {});

  app.post("/campaigns", campaignsController);
  app.get("/health", healthController);

  return app;
}

module.exports = createApp;
