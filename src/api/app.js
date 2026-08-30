const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("node:path");
const { createAuthGate } = require("./auth-gate");
const createAppUsersController = require("./controllers/app-users.controller");
const { evolutionConfig } = require("../config/evolution");
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
const trilhaSequenceService = require("../services/trilha-sequence.service");
const videoCaptionsService = require("../services/video-captions.service");
const videoCatalogService = require("../services/video-catalog.service");
const whatsappInstancesService = require("../services/whatsapp-instances.service");

function createApp(dependencies = {}) {
  const app = express();
  const allowedOrigins = String(process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.set("trust proxy", dependencies.trustProxy || process.env.EXPRESS_TRUST_PROXY || "loopback");
  // Em producao o painel e' servido pela propria API (mesma origem), entao a
  // politica cross-origin so precisa ser permissiva durante o desenvolvimento.
  const isProduction = process.env.NODE_ENV === "production";

  app.use(
    cors({
      origin(origin, callback) {
        // Sem cabecalho Origin nao e' uma request cross-origin de navegador
        // (navegacao same-origin, curl, healthcheck do Docker): liberar aqui nao
        // amplia superficie e bloquear quebraria esses casos.
        if (!origin) {
          callback(null, true);
          return;
        }

        // "null" e' a Origin que o navegador manda de contexto opaco: pagina
        // aberta via file:// e, principalmente, <iframe sandbox>. Como a
        // resposta vai com credentials, aceitar "null" permitiria a qualquer
        // site embutir um iframe sandboxed e ler os dados autenticados da API.
        // O fallback file:// do nav.js/access.html nao e' usado na pratica.
        if (origin === "null") {
          callback(null, false);
          return;
        }

        try {
          const url = new URL(origin);
          // localhost so em desenvolvimento: cobre servir o painel por um static
          // server separado (ex.: Live Server) apontando para a API em :3000.
          // Em producao isso deixaria qualquer processo local ler a API.
          const isLocalDevOrigin =
            !isProduction && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);

          callback(null, isLocalDevOrigin || allowedOrigins.includes(origin));
        } catch (error) {
          callback(null, false);
        }
      },
      // Necessario para o cookie de sessao (estimulo_session) viajar quando o
      // painel roda fora da porta da API - sem isso o navegador descarta o
      // Set-Cookie de respostas cross-origin mesmo com credentials: "include".
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
  const trilhaSequenceServiceDependency = dependencies.trilhaSequenceService || trilhaSequenceService;
  const videoCaptionsServiceDependency = dependencies.videoCaptionsService || videoCaptionsService;
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
  const reportController = createReportController({
    dispatchLogsService: dispatchLogsServiceDependency,
  });
  const settingsController = createSettingsController({ settingsService: settingsServiceDependency });
  const trilhasController = createTrilhasController({
    trilhasService: trilhasServiceDependency,
    trilhaSequenceService: trilhaSequenceServiceDependency,
  });
  const videoCatalogController = createVideoCatalogController({
    videoCaptionsService: videoCaptionsServiceDependency,
    videoCatalogService: videoService,
  });
  const whatsappInstancesController = createWhatsappInstancesController({
    whatsappInstancesService: whatsappInstancesServiceDependency,
  });

  // Anexo de imagem/video do Disparador Pontual: fica so em RAM (memoryStorage),
  // nunca grava em disco. O limite de bytes do arquivo bruto usa 3/4 do limite
  // de payload da Evolution (evolutionConfig.maxMediaPayloadBytes) para sobrar
  // espaco para os +33% que o base64 adiciona antes de montar o payload.
  const mediaUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: Math.floor((evolutionConfig.maxMediaPayloadBytes * 3) / 4) },
  });

  // multer chama next(error) fora do try/catch do controller; sem isso o erro
  // (ex.: arquivo acima do limite) cai no handler default do Express e devolve
  // HTML em vez do JSON { error } que o resto da API usa.
  function handleMediaUpload(field) {
    const middleware = mediaUpload.single(field);

    return (req, res, next) => {
      middleware(req, res, (error) => {
        if (!error) {
          next();
          return;
        }

        if (error.code === "LIMIT_FILE_SIZE") {
          res.status(413).json({ error: "Arquivo de midia excede o tamanho maximo permitido" });
          return;
        }

        res.status(400).json({ error: error.message || "Falha ao processar o arquivo enviado" });
      });
    };
  }

  app.get("/campaigns", campaignsController.list);
  app.post("/campaigns", campaignsController.create);
  app.post("/campaigns/dispatch", campaignsController.dispatch);
  app.get("/campaigns/:id/groups", campaignsController.listGroups);
  app.get("/campaigns/:id/captions/progress", campaignVideoCaptionsController.getProgress);
  app.patch("/campaigns/:id/captions/:captionRowId", campaignVideoCaptionsController.updateCaption);
  app.post("/campaigns/:id/captions/:captionRowId/regenerate", campaignVideoCaptionsController.regenerateCaption);
  app.post("/campaigns/:id/dispatch/confirm", campaignsController.confirmDispatch);
  app.post("/campaigns/:id/pause", campaignsController.pause);
  app.post("/campaigns/:id/resume", campaignsController.resume);
  app.post("/campaigns/:id/cancel", campaignsController.cancel);
  app.get("/campaigns/:id", campaignsController.getById);
  app.delete("/campaigns/:id", campaignsController.remove);
  app.post("/mensagens/dispatch", mensagensController.dispatch);
  app.post("/mensagens/dispatch/schedule", mensagensController.schedule);
  app.post("/mensagens/dispatch/media", handleMediaUpload("media"), mensagensController.dispatchWithMedia);
  app.post(
    "/mensagens/dispatch/schedule/media",
    handleMediaUpload("media"),
    mensagensController.scheduleWithMedia
  );
  app.get("/notifications", notificationsController.list);
  app.post("/notifications/read-all", notificationsController.markAllRead);
  app.post("/notifications/:id/read", notificationsController.markRead);
  app.delete("/notifications/read", notificationsController.clearRead);
  app.get("/organizations", organizationsController.list);
  app.post("/organizations", organizationsController.create);
  app.patch("/organizations/:id", organizationsController.update);
  app.delete("/organizations/:id", organizationsController.remove);
  app.get("/reports/dispatches", reportController.listDispatches);
  app.delete("/reports/dispatches", authGate.requireAdmin, reportController.hideDispatches);
  app.get("/trilhas", trilhasController.listAll);
  app.get("/trilhas/overview", trilhasController.listOverview);
  app.get("/trilhas/by-perfil", trilhasController.listByPerfil);
  app.get("/trilhas/sequence", trilhasController.listSequence);
  app.post("/trilhas/sequence", trilhasController.addTrilhaToSequence);
  app.patch("/trilhas/sequence/reorder", trilhasController.reorderSequence);
  app.delete("/trilhas/sequence/:trilhaId", trilhasController.removeFromSequence);
  app.get("/trilhas/desvios", trilhasController.listDesvios);
  app.post("/trilhas/desvios", trilhasController.createDesvio);
  app.delete("/trilhas/desvios/:id", trilhasController.removeDesvio);
  app.get("/trilhas/selectable-videos", trilhasController.listSelectableVideos);
  app.post("/trilhas", trilhasController.createTrilha);
  app.patch("/trilhas/:id", trilhasController.renameTrilha);
  app.delete("/trilhas/:id", trilhasController.removeTrilha);
  app.get("/trilhas/:id/usage", trilhasController.getTrilhaUsage);
  app.patch("/trilhas/:id/perfis", trilhasController.updateTrailPerfis);
  app.post("/trilhas/:id/videos", trilhasController.addVideoToTrilha);
  app.delete("/trilhas/:id/videos/:videoId", trilhasController.removeVideoFromTrilha);
  app.post("/trilhas/:id/videos/:videoId/move", trilhasController.moveVideoBetweenTrilhas);
  app.post("/trilhas/:id/reorder", trilhasController.reorderTrilhaVideos);
  app.post("/video-catalog/transcript", videoCatalogController.transcribeByDriveFileId);
  app.post("/video-catalog/:id/transcript", videoCatalogController.transcribeById);
  app.patch("/video-catalog/:id", videoCatalogController.renameVideo);
  app.get("/video-catalog/:id/captions", videoCatalogController.listCaptions);
  app.patch("/video-catalog/:id/captions/:captionId", videoCatalogController.updateCaption);
  app.get("/groups/search", groupsController.search);
  app.get("/groups/unclassified", groupsController.listWithoutSegment);
  app.post("/groups/sync", groupsController.syncFromEvolution);
  app.get("/groups/:id/video-progress", groupVideoProgressController.getGroupProgress);
  app.get("/groups/:id/next-trilha", groupsController.previewNextTrilha);
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
  // Criar ou (des)ativar login exige is_admin=true na conta de quem esta logado
  // (checado por requireAdmin a partir da sessao) - substitui a antiga senha
  // mestra compartilhada por uma permissao rastreavel a uma pessoa.
  app.post("/settings/app-users", authGate.requireAdmin, appUsersController.create);
  app.patch("/settings/app-users/:id", authGate.requireAdmin, appUsersController.setActive);
  app.delete("/settings/app-users/:id", authGate.requireAdmin, appUsersController.remove);
  app.get("/group-profiles", groupProfilesController.list);
  app.post("/group-profiles", groupProfilesController.create);
  app.get("/group-profiles/merges", groupProfilesController.listMerges);
  app.post("/group-profiles/merge", groupProfilesController.merge);
  app.post("/group-profiles/reorder", groupProfilesController.reorder);
  app.post("/group-profiles/:id/unmerge", groupProfilesController.unmerge);
  app.patch("/group-profiles/:id", groupProfilesController.update);
  app.delete("/group-profiles/:id", groupProfilesController.remove);
  app.get("/health", healthController);

  return app;
}

module.exports = createApp;
