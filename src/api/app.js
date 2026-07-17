const express = require("express");
const path = require("node:path");
const createCampaignsController = require("./controllers/campaigns.controller");
const createGroupsController = require("./controllers/groups.controller");
const createHealthController = require("./controllers/health.controller");
const createOrganizationsController = require("./controllers/organizations.controller");
const createVideoCatalogController = require("./controllers/video-catalog.controller");
const campaignsService = require("../services/campaigns.service");
const groupsService = require("../services/groups.service");
const organizationsService = require("../services/organizations.service");
const videoCatalogService = require("../services/video-catalog.service");

function createApp(dependencies = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "../../public")));

  const campaignService = dependencies.campaignService || campaignsService;
  const groupService = dependencies.groupService || groupsService;
  const organizationService = dependencies.organizationService || organizationsService;
  const videoService = dependencies.videoCatalogService || videoCatalogService;
  const campaignsController = createCampaignsController({ campaignService });
  const groupsController = createGroupsController({ groupService });
  const healthController = createHealthController(dependencies.healthController || {});
  const organizationsController = createOrganizationsController({ organizationService });
  const videoCatalogController = createVideoCatalogController({ videoCatalogService: videoService });

  app.post("/campaigns", campaignsController);
  app.get("/organizations", organizationsController.list);
  app.get("/video-catalog/trails", videoCatalogController.listTrailsByProfile);
  app.get("/groups/search", groupsController.search);
  app.get("/groups/unclassified", groupsController.listWithoutSegment);
  app.post("/groups/sync", groupsController.syncFromEvolution);
  app.patch("/groups/:id", groupsController.updateOperationalSettings);
  app.patch("/groups/:id/operational-settings", groupsController.updateOperationalSettings);
  app.post("/groups/:id/test-dispatch", groupsController.dispatchTestVideo);
  app.get("/health", healthController);

  return app;
}

module.exports = createApp;
