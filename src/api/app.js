const express = require("express");
const path = require("node:path");
const createCampaignsController = require("./controllers/campaigns.controller");
const createCampaignVideoCaptionsController = require("./controllers/campaign-video-captions.controller");
const createGroupsController = require("./controllers/groups.controller");
const createGroupVideoProgressController = require("./controllers/group-video-progress.controller");
const createHealthController = require("./controllers/health.controller");
const createOrganizationsController = require("./controllers/organizations.controller");
const createReportController = require("./controllers/report.controller");
const createTrilhasController = require("./controllers/trilhas.controller");
const createVideoCatalogController = require("./controllers/video-catalog.controller");
const campaignsService = require("../services/campaigns.service");
const campaignVideoCaptionsService = require("../services/campaign-video-captions.service");
const dispatchLogsService = require("../services/dispatch-logs.service");
const groupsService = require("../services/groups.service");
const groupVideoProgressService = require("../services/group-video-progress.service");
const organizationsService = require("../services/organizations.service");
const trilhasService = require("../services/trilhas.service");
const videoCatalogService = require("../services/video-catalog.service");

function createApp(dependencies = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "../../public")));

  const campaignService = dependencies.campaignService || campaignsService;
  const campaignVideoCaptionsServiceDependency =
    dependencies.campaignVideoCaptionsService || campaignVideoCaptionsService;
  const groupService = dependencies.groupService || groupsService;
  const groupVideoProgressServiceDependency = dependencies.groupVideoProgressService || groupVideoProgressService;
  const organizationService = dependencies.organizationService || organizationsService;
  const dispatchLogsServiceDependency = dependencies.dispatchLogsService || dispatchLogsService;
  const trilhasServiceDependency = dependencies.trilhasService || trilhasService;
  const videoService = dependencies.videoCatalogService || videoCatalogService;
  const campaignsController = createCampaignsController({ campaignService });
  const campaignVideoCaptionsController = createCampaignVideoCaptionsController({
    campaignVideoCaptionsService: campaignVideoCaptionsServiceDependency,
  });
  const groupsController = createGroupsController({ groupService });
  const groupVideoProgressController = createGroupVideoProgressController({
    groupService,
    groupVideoProgressService: groupVideoProgressServiceDependency,
  });
  const healthController = createHealthController(dependencies.healthController || {});
  const organizationsController = createOrganizationsController({ organizationService });
  const reportController = createReportController({ dispatchLogsService: dispatchLogsServiceDependency });
  const trilhasController = createTrilhasController({ trilhasService: trilhasServiceDependency });
  const videoCatalogController = createVideoCatalogController({ videoCatalogService: videoService });

  app.get("/campaigns", campaignsController.list);
  app.post("/campaigns", campaignsController.create);
  app.post("/campaigns/dispatch", campaignsController.dispatch);
  app.get("/campaigns/:id/groups", campaignsController.listGroups);
  app.get("/campaigns/:id/captions/progress", campaignVideoCaptionsController.getProgress);
  app.patch("/campaigns/:id/captions/:captionRowId", campaignVideoCaptionsController.updateCaption);
  app.post("/campaigns/:id/dispatch/confirm", campaignsController.confirmDispatch);
  app.get("/campaigns/:id", campaignsController.getById);
  app.get("/organizations", organizationsController.list);
  app.post("/organizations", organizationsController.create);
  app.patch("/organizations/:id", organizationsController.update);
  app.get("/reports/dispatches", reportController.listDispatches);
  app.get("/trilhas", trilhasController.listByOrganization);
  app.get("/trilhas/overview", trilhasController.listOverview);
  app.get("/trilhas/selectable-videos", trilhasController.listSelectableVideos);
  app.post("/trilhas", trilhasController.createTrilha);
  app.patch("/trilhas/:id", trilhasController.renameTrilha);
  app.delete("/trilhas/:id", trilhasController.removeTrilha);
  app.patch("/trilhas/:id/perfis", trilhasController.updateTrailPerfis);
  app.post("/trilhas/:id/videos", trilhasController.addVideoToTrilha);
  app.delete("/trilhas/:id/videos/:videoId", trilhasController.removeVideoFromTrilha);
  app.post("/trilhas/:id/videos/:videoId/move", trilhasController.moveVideoBetweenTrilhas);
  app.post("/trilhas/:id/reorder", trilhasController.reorderTrilhaVideos);
  app.post("/video-catalog/transcript", videoCatalogController.transcribeByDriveFileId);
  app.post("/video-catalog/:id/transcript", videoCatalogController.transcribeById);
  app.get("/groups/search", groupsController.search);
  app.get("/groups/unclassified", groupsController.listWithoutSegment);
  app.post("/groups/sync", groupsController.syncFromEvolution);
  app.get("/groups/:id/video-progress", groupVideoProgressController.getGroupProgress);
  app.patch("/groups/:id", groupsController.updateOperationalSettings);
  app.patch("/groups/:id/operational-settings", groupsController.updateOperationalSettings);
  app.post("/groups/:id/test-dispatch", groupsController.dispatchTestVideo);
  app.get("/health", healthController);

  return app;
}

module.exports = createApp;
