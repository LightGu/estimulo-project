const express = require("express");
const cors = require("cors");
const path = require("node:path");
const { createAuthGate } = require("./auth-gate");
const createAppUsersController = require("./controllers/app-users.controller");
const createCampaignsController = require("./controllers/campaigns.controller");
const createCampaignVideoCaptionsController = require("./controllers/campaign-video-captions.controller");
const createGroupProfilesController = require("./controllers/group-profiles.controller");
const createGroupsController = require("./controllers/groups.controller");
const createGroupVideoProgressController = require("./controllers/group-video-progress.controller");
const createHealthController = require("./controllers/health.controller");
const createMensagensController = require("./controllers/mensagens.controller");
const createNotificationsController = require("./controllers/notifications.controller");
const createOrganizationsController = require("./controllers/organizations.controller");
const createReportController = require("./controllers/report.controller");
const createSettingsController = require("./controllers/settings.controller");
const createTrilhasController = require("./controllers/trilhas.controller");
const createVideoCatalogController = require("./controllers/video-catalog.controller");
const createWhatsappInstancesController = require("./controllers/whatsapp-instances.controller");
const authService = require("../services/auth.service");
const campaignsService = require("../services/campaigns.service");
const campaignVideoCaptionsService = require("../services/campaign-video-captions.service");
const dispatchLogsService = require("../services/dispatch-logs.service");
const groupProfilesService = require("../services/group-profiles.service");
const groupsService = require("../services/groups.service");
const groupVideoProgressService = require("../services/group-video-progress.service");
const mensagensService = require("../services/mensagens.service");
const inAppNotificationsService = require("../services/in-app-notifications.service");
const organizationsService = require("../services/organizations.service");
const settingsService = require("../services/settings.service");
const trilhasService = require("../services/trilhas.service");
const videoCatalogService = require("../services/video-catalog.service");
const whatsappInstancesService = require("../services/whatsapp-instances.service");

function createApp(dependencies = {}) {
  const app = express();
  const allowedOrigins = String(process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.set("trust proxy", dependencies.trustProxy || process.env.EXPRESS_TRUST_PROXY || "loopback");
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || origin === "null") {
          callback(null, true);
          return;
        }

        try {
          const url = new URL(origin);
          callback(
            null,
            ["localhost", "127.0.0.1", "::1"].includes(url.hostname) || allowedOrigins.includes(origin)
          );
        } catch (error) {
          callback(null, false);
        }
      },
      // Necessario para o cookie de sessao (estimulo_session) ser aceito quando o
      // painel e' aberto fora da porta da API (ex.: direto do file://, cenario que
      // o fallback do nav.js/access.html cobre) - sem isso o navegador descarta o
      // Set-Cookie de respostas cross-origin mesmo com fetch({ credentials: "include" }).
      credentials: true,
    })
  );
  app.use(express.json());

  const publicRoot = path.join(__dirname, "../../public");
  const authGate = createAuthGate(dependencies.authGate || {});
  const authServiceDependency = dependencies.authService || authService;
  const appUsersController = createAppUsersController({ authService: authServiceDependency });

  app.get("/access/status", authGate.statusHandler);
  app.post("/access/login", authGate.loginHandler);
  app.post("/access/logout", authGate.logoutHandler);
  // Publica de proposito: qualquer pessoa que souber a senha mestra
  // (ESTIMULO_ADMIN_MASTER_PASSWORD) consegue criar seu proprio login sem
  // precisar de uma sessao previa - resolve o problema de "ninguem loga para
  // criar o primeiro usuario" e permite autoatendimento para novas pessoas.
  app.post("/access/register", appUsersController.create);
  app.use(authGate.middleware);
  // Nao existe public/index.html (so public/app/*) - sem isso, "/" com
  // sessao valida caia em "Cannot GET /" porque o static nao acha arquivo
  // nenhum para servir na raiz.
  app.get("/", (req, res) => res.redirect("/app/index.html"));
  app.use(express.static(publicRoot));

  const campaignService = dependencies.campaignService || campaignsService;
  const campaignVideoCaptionsServiceDependency =
    dependencies.campaignVideoCaptionsService || campaignVideoCaptionsService;
  const groupProfilesServiceDependency = dependencies.groupProfilesService || groupProfilesService;
  const groupService = dependencies.groupService || groupsService;
  const groupVideoProgressServiceDependency = dependencies.groupVideoProgressService || groupVideoProgressService;
  const mensagensServiceDependency = dependencies.mensagensService || mensagensService;
  const inAppNotificationsServiceDependency = dependencies.inAppNotificationsService || inAppNotificationsService;
  const organizationService = dependencies.organizationService || organizationsService;
  const dispatchLogsServiceDependency = dependencies.dispatchLogsService || dispatchLogsService;
  const settingsServiceDependency = dependencies.settingsService || settingsService;
  const trilhasServiceDependency = dependencies.trilhasService || trilhasService;
  const videoService = dependencies.videoCatalogService || videoCatalogService;
  const whatsappInstancesServiceDependency = dependencies.whatsappInstancesService || whatsappInstancesService;
  const campaignsController = createCampaignsController({ campaignService });
  const campaignVideoCaptionsController = createCampaignVideoCaptionsController({
    campaignVideoCaptionsService: campaignVideoCaptionsServiceDependency,
  });
  const groupProfilesController = createGroupProfilesController({ groupProfilesService: groupProfilesServiceDependency });
  const groupsController = createGroupsController({ groupService });
  const groupVideoProgressController = createGroupVideoProgressController({
    groupService,
    groupVideoProgressService: groupVideoProgressServiceDependency,
  });
  const healthController = createHealthController(dependencies.healthController || {});
  const mensagensController = createMensagensController({ mensagensService: mensagensServiceDependency });
  const notificationsController = createNotificationsController({
    notificationsService: inAppNotificationsServiceDependency,
  });
  const organizationsController = createOrganizationsController({ organizationService });
  const reportController = createReportController({ dispatchLogsService: dispatchLogsServiceDependency });
  const settingsController = createSettingsController({ settingsService: settingsServiceDependency });
  const trilhasController = createTrilhasController({ trilhasService: trilhasServiceDependency });
  const videoCatalogController = createVideoCatalogController({ videoCatalogService: videoService });
  const whatsappInstancesController = createWhatsappInstancesController({
    whatsappInstancesService: whatsappInstancesServiceDependency,
  });

  app.get("/campaigns", campaignsController.list);
  app.post("/campaigns", campaignsController.create);
  app.post("/campaigns/dispatch", campaignsController.dispatch);
  app.get("/campaigns/:id/groups", campaignsController.listGroups);
  app.get("/campaigns/:id/captions/progress", campaignVideoCaptionsController.getProgress);
  app.patch("/campaigns/:id/captions/:captionRowId", campaignVideoCaptionsController.updateCaption);
  app.post("/campaigns/:id/captions/:captionRowId/regenerate", campaignVideoCaptionsController.regenerateCaption);
  app.post("/campaigns/:id/dispatch/confirm", campaignsController.confirmDispatch);
  app.get("/campaigns/:id", campaignsController.getById);
  app.delete("/campaigns/:id", campaignsController.remove);
  app.post("/mensagens/dispatch", mensagensController.dispatch);
  app.post("/mensagens/dispatch/schedule", mensagensController.schedule);
  app.get("/notifications", notificationsController.list);
  app.post("/notifications/read-all", notificationsController.markAllRead);
  app.post("/notifications/:id/read", notificationsController.markRead);
  app.get("/organizations", organizationsController.list);
  app.post("/organizations", organizationsController.create);
  app.patch("/organizations/:id", organizationsController.update);
  app.delete("/organizations/:id", organizationsController.remove);
  app.get("/reports/dispatches", reportController.listDispatches);
  app.get("/trilhas", trilhasController.listAll);
  app.get("/trilhas/overview", trilhasController.listOverview);
  app.get("/trilhas/by-perfil", trilhasController.listByPerfil);
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
  app.post("/groups/:id/force-next-video", groupsController.forceNextVideo);
  app.get("/settings/drive", settingsController.getDriveSettings);
  app.patch("/settings/drive/root-folder", settingsController.updateDriveRootFolder);
  app.patch("/settings/drive/schedule", settingsController.updateDriveSchedule);
  app.post("/settings/drive/test-connection", settingsController.testConnection);
  app.post("/settings/drive/reindex", settingsController.reindexNow);
  app.get("/settings/profile", settingsController.getProfileSettings);
  app.patch("/settings/profile", settingsController.updateProfileSettings);
  app.get("/settings/schedule", settingsController.getScheduleSettings);
  app.patch("/settings/schedule", settingsController.updateScheduleSettings);
  app.get("/settings/notifications", settingsController.getNotificationSettings);
  app.patch("/settings/notifications", settingsController.updateNotificationSettings);
  app.get("/settings/ai", settingsController.getAIAgentsSettings);
  app.patch("/settings/ai", settingsController.updateAIAgentsSettings);
  app.get("/settings/database/health", settingsController.testDatabaseConnection);
  app.get("/settings/dispatch-rules", settingsController.getDispatchRulesSettings);
  app.patch("/settings/dispatch-rules", settingsController.updateDispatchRulesSettings);
  app.get("/settings/whatsapp/instances", whatsappInstancesController.list);
  app.post("/settings/whatsapp/test-connection", whatsappInstancesController.testConnection);
  app.post("/settings/whatsapp/instances", whatsappInstancesController.register);
  app.get("/settings/whatsapp/instances/:id/qr", whatsappInstancesController.getQrCode);
  app.get("/settings/whatsapp/instances/:id/status", whatsappInstancesController.getStatus);
  app.delete("/settings/whatsapp/instances/:id", whatsappInstancesController.remove);
  app.post("/settings/whatsapp/instances/reorder", whatsappInstancesController.reorder);
  app.get("/settings/whatsapp/rotation", whatsappInstancesController.getRotation);
  app.patch("/settings/whatsapp/rotation", whatsappInstancesController.updateRotation);
  app.get("/settings/app-users", appUsersController.list);
  app.patch("/settings/app-users/:id", appUsersController.setActive);
  app.get("/group-profiles", groupProfilesController.list);
  app.post("/group-profiles", groupProfilesController.create);
  app.get("/group-profiles/merges", groupProfilesController.listMerges);
  app.post("/group-profiles/merge", groupProfilesController.merge);
  app.post("/group-profiles/:id/unmerge", groupProfilesController.unmerge);
  app.patch("/group-profiles/:id", groupProfilesController.update);
  app.delete("/group-profiles/:id", groupProfilesController.remove);
  app.get("/health", healthController);

  return app;
}

module.exports = createApp;
