/*
  Fila da geracao de legendas de uma campanha de video (Etapa 2).

  O QUE ERA ANTES.

  services/campaigns.service.js -> dispatchCampaign chamava:

      campaignVideoCaptionsServiceDependency
        .generateCaptionsForCampaign(result.campaign.id)
        .then(() => maybeAutoConfirmDispatch(...))
        .catch((error) => console.error(...));

  Uma promise solta no processo da API. A campanha nascia em "gerando_legendas"
  e SO essa promise podia tira-la de la. Consequencias, todas observadas ou
  diretamente deduziveis do codigo:

    - DEPLOY MATAVA A GERACAO. Todo deploy recria o container da api
      (docker compose up -d api). Uma campanha com a geracao em andamento
      perdia a promise no meio e ficava em "gerando_legendas" PARA SEMPRE: nao
      havia retry, nem estado de onde retomar. E o padrao de
      auto_send_after_timeout e' desligado, entao o sweep de
      dispatch-review-timeout tambem nao a resgatava (isso foi corrigido em
      separado: a deteccao agora roda sempre e notifica, mas notificar nao gera
      a legenda).

    - RODAVA DENTRO DA API. Download do Drive, extracao de audio com ffmpeg,
      transcricao e chamada ao Gemini por grupo, competindo com o
      atendimento das requisicoes no mesmo event loop.

    - SEM TETO DE CONCORRENCIA. Duas campanhas despachadas juntas eram dois
      lacos de geracao simultaneos no mesmo processo, os dois consumindo a cota
      diaria do Gemini.

    - ERRO SO NO console.error. Nenhuma tentativa, nenhuma visibilidade, nenhum
      Sentry (createWorker registra "failed" no Sentry; uma promise solta nao).

  O QUE E AGORA.

  Um job por campanha, nesta fila. Sobrevive a restart porque vive no Redis;
  tem retry com backoff; concorrencia 1 por padrao (a cota do Gemini e' um
  recurso global, nao por campanha); e a falha final vai para o Sentry e para a
  notificacao in-app.

  O QUE TORNOU O RETRY SEGURO.

  Retentar so faz sentido porque a geracao passou a ser retomavel:
  generateCaptionsForCampaign aceita `{ resume: true }` e preserva as linhas ja
  em "gerado". Sem isso, a segunda tentativa desfaria a primeira -
  createManyPending e' um upsert que devolve a linha para "pendente" -, gastando
  a cota do Gemini de novo e descartando texto que o usuario tivesse ajustado a
  mao na Etapa 2.
*/
const { createQueue, createQueueEvents, createWorker } = require("./bullmq");
const { queueNames } = require("./names");
const defaultCampaignsRepository = require("../repositories/campaigns.repository");
const defaultCampaignVideoCaptionsService = require("../services/campaign-video-captions.service");
const defaultSettingsService = require("../services/settings.service");
const defaultInAppNotificationsService = require("../services/in-app-notifications.service");

const CAMPAIGN_CAPTIONS_JOB_NAME = "campaign-captions";
const CAMPAIGN_STATUS_GENERATING_CAPTIONS = "gerando_legendas";

// A geracao percorre os grupos em serie, e cada grupo pode baixar um video do
// Drive, extrair o audio com ffmpeg, transcrever e chamar o Gemini. Uma campanha
// com muitos grupos leva dezenas de minutos; o lock precisa cobrir isso, senao a
// BullMQ considera o job travado e o reentrega no meio da geracao.
const DEFAULT_CAMPAIGN_CAPTIONS_LOCK_MS = 45 * 60 * 1000;
// A cota do Gemini e' um recurso global do projeto, nao por campanha: duas
// geracoes em paralelo nao terminam mais rapido, so esgotam a cota mais cedo e
// fazem as duas falharem por 429.
const DEFAULT_CAMPAIGN_CAPTIONS_CONCURRENCY = 1;
const DEFAULT_CAMPAIGN_CAPTIONS_ATTEMPTS = 3;

let campaignCaptionsQueueInstance;

function resolvePositiveInt(rawValue, fallback) {
  const parsed = Number(rawValue);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.trunc(parsed);
}

function resolveCampaignCaptionsLockMs() {
  return resolvePositiveInt(process.env.CAMPAIGN_CAPTIONS_JOB_LOCK_MS, DEFAULT_CAMPAIGN_CAPTIONS_LOCK_MS);
}

function resolveCampaignCaptionsConcurrency() {
  return resolvePositiveInt(process.env.CAMPAIGN_CAPTIONS_CONCURRENCY, DEFAULT_CAMPAIGN_CAPTIONS_CONCURRENCY);
}

function resolveCampaignCaptionsAttempts() {
  return resolvePositiveInt(process.env.CAMPAIGN_CAPTIONS_ATTEMPTS, DEFAULT_CAMPAIGN_CAPTIONS_ATTEMPTS);
}

/*
  Identidade logica do job: uma geracao por campanha.

  A BullMQ recusa em silencio um add() com jobId ja existente, e e' essa recusa
  que serve de protecao aqui - dois cliques em "Disparar", ou um retry manual da
  tela, nao podem virar dois lacos de geracao concorrentes consumindo a cota do
  Gemini sobre as MESMAS linhas.

  O saneamento de ":" e obrigatorio: a BullMQ so aceita ":" num jobId customizado
  quando o resultado tem exatamente 3 segmentos (formato reservado de repeatable
  jobs). UUID nao tem ":", mas o ramo de teste manual pode passar outra coisa.
*/
function buildCampaignCaptionsJobId(campaignId) {
  return `captions|${String(campaignId).replace(/:/g, "_")}`;
}

function getCampaignCaptionsQueue() {
  if (!campaignCaptionsQueueInstance) {
    campaignCaptionsQueueInstance = createQueue(queueNames.campaignCaptions, {
      defaultJobOptions: {
        attempts: resolveCampaignCaptionsAttempts(),
        backoff: {
          type: "exponential",
          // Bem mais longo que o padrao de 5s da infraestrutura: a falha tipica
          // aqui e' cota do Gemini (429), que nao passa em segundos.
          delay: 60 * 1000,
        },
        // Mantidos para inspecao: uma campanha que nao gerou legenda e' o tipo
        // de caso que se investiga depois, e o job guarda o motivo.
        removeOnComplete: { age: 60 * 60 * 24 * 3, count: 200 },
        removeOnFail: { age: 60 * 60 * 24 * 14, count: 500 },
      },
    });
  }

  return campaignCaptionsQueueInstance;
}

function buildCampaignCaptionsJobData(params = {}) {
  const campaignId = params.campaign_id || params.campaignId;

  if (!campaignId) {
    throw new Error("campaign_id e obrigatorio para enfileirar campaign-captions");
  }

  return {
    campaign_id: campaignId,
    // Payload original do disparo, necessario para a confirmacao automatica no
    // fim da geracao (confirmDispatch le janela/jitter/timezone de la). Viaja no
    // job porque quem confirma e' o worker, minutos depois, em outro processo.
    confirm_payload: params.confirm_payload || params.confirmPayload || null,
    requested_at: params.requested_at || new Date().toISOString(),
  };
}

/*
  Enfileira a geracao.

  Um jobId ja existente e' o caso normal de protecao (ver
  buildCampaignCaptionsJobId), mas ele tambem sobrevive ao fim do job por conta
  do removeOnComplete/removeOnFail acima. Um job em estado terminal nao esta mais
  protegendo nada - so bloqueando uma nova geracao legitima da mesma campanha -,
  entao ele e' removido e o pedido segue. Job ainda ativo/esperando: devolve o
  que ja existe, sem criar um segundo.
*/
async function addCampaignCaptionsJob(params, options = {}) {
  const jobData = buildCampaignCaptionsJobData(params);
  const jobId = buildCampaignCaptionsJobId(jobData.campaign_id);
  const queue = getCampaignCaptionsQueue();
  const existing = await queue.getJob(jobId).catch(() => null);

  if (existing) {
    const state = await existing.getState().catch(() => null);

    if (state === "completed" || state === "failed") {
      await existing.remove().catch(() => undefined);
    } else {
      return existing;
    }
  }

  return queue.add(CAMPAIGN_CAPTIONS_JOB_NAME, jobData, { jobId, ...options });
}

function createCampaignCaptionsProcessor(options = {}) {
  const {
    logger = console,
    campaignsRepository = defaultCampaignsRepository,
    campaignVideoCaptionsService = defaultCampaignVideoCaptionsService,
    settingsService = defaultSettingsService,
    inAppNotificationsService = defaultInAppNotificationsService,
    // Lazy de proposito: services/campaigns.service.js importa ESTE modulo para
    // enfileirar, entao resolve-lo no topo fecharia um ciclo de require. Aqui
    // ele so e' carregado quando um job realmente precisa confirmar o disparo.
    resolveCampaignsService = () => require("../services/campaigns.service"),
  } = options;

  async function shouldAutoConfirm() {
    try {
      const dispatchRules = await settingsService.getDispatchRulesSettings();

      return dispatchRules.require_human_review === false;
    } catch (error) {
      // Nao saber a regra nao autoriza enviar sem revisao: falha fechado.
      logger.warn &&
        logger.warn(
          JSON.stringify({
            event: "campaign_captions.dispatch_rules_unavailable",
            error_message: error && error.message,
          })
        );

      return false;
    }
  }

  return async function campaignCaptionsWorker(job) {
    const campaignId = job.data.campaign_id;
    const startedAt = new Date().toISOString();
    const campaign = await campaignsRepository.findById(campaignId);

    if (!campaign) {
      // Campanha apagada entre o pedido e a execucao: nada a gerar, e falhar
      // faria o job retentar tres vezes contra uma linha que nao existe.
      logger.warn &&
        logger.warn(
          JSON.stringify({
            event: "campaign_captions.skipped_campaign_missing",
            job_id: job.id,
            campaign_id: campaignId,
          })
        );

      return { status: "skipped", reason: "campanha_inexistente" };
    }

    // Cancelada durante a espera na fila, ou ja confirmada por outro caminho
    // (confirmacao manual na tela enquanto o job aguardava). Nos dois casos
    // gerar legenda agora seria trabalho jogado fora - e no caso de campanha
    // cancelada, tambem consumo de cota para nada.
    if (campaign.status !== CAMPAIGN_STATUS_GENERATING_CAPTIONS) {
      logger.warn &&
        logger.warn(
          JSON.stringify({
            event: "campaign_captions.skipped_status",
            job_id: job.id,
            campaign_id: campaignId,
            status: campaign.status,
          })
        );

      return { status: "skipped", reason: `status_${campaign.status}` };
    }

    logger.info &&
      logger.info(
        JSON.stringify({
          event: "campaign_captions.started",
          job_id: job.id,
          campaign_id: campaignId,
          attempt: job.attemptsMade + 1,
          started_at: startedAt,
        })
      );

    try {
      // `resume: true` e' o que torna a retentativa segura: preserva as legendas
      // ja geradas em vez de devolver a campanha inteira para "pendente".
      const result = await campaignVideoCaptionsService.generateCaptionsForCampaign(campaignId, { resume: true });
      const progress = result && result.progress ? result.progress : null;

      logger.info &&
        logger.info(
          JSON.stringify({
            event: "campaign_captions.generated",
            job_id: job.id,
            campaign_id: campaignId,
            total: progress && progress.total,
            gerado: progress && progress.gerado,
            erro: progress && progress.erro,
          })
        );

      // Legenda em erro deixa a campanha em "gerando_legendas" a espera de acao
      // humana (regerar a linha na Etapa 2). Falhar o job aqui faria a geracao
      // inteira ser retentada por causa de um video problematico; a linha em
      // erro ja esta registrada e visivel na tela, e notifyAiError ja avisou.
      if (progress && progress.erro > 0) {
        return { status: "partial", progress };
      }

      if (!progress || progress.pendente > 0) {
        // Nem gerado nem em erro: alguma linha ficou para tras. Vale retentar -
        // e' o caso de uma interrupcao no meio do laco.
        throw new Error(
          `Geracao de legendas terminou incompleta para a campanha ${campaignId}: ` +
            `${(progress && progress.gerado) || 0}/${(progress && progress.total) || 0} geradas`
        );
      }

      if (job.data.confirm_payload && (await shouldAutoConfirm())) {
        // Re-le a campanha: confirmDispatch cria logs pendentes e job de
        // trigger, e o status atual e' a unica evidencia de que isso ainda nao
        // aconteceu (a geracao acima ja pode ter levado minutos).
        const current = await campaignsRepository.findById(campaignId);

        if (current && current.status === CAMPAIGN_STATUS_GENERATING_CAPTIONS) {
          try {
            await resolveCampaignsService().confirmDispatch(campaignId, job.data.confirm_payload);
          } catch (error) {
            // A geracao FOI concluida; so a confirmacao automatica falhou. Nao
            // pode derrubar o job e disparar uma nova rodada de geracao - a
            // campanha fica em "gerando_legendas" e a tela permite confirmar a
            // mao, que e' o fluxo padrao de qualquer forma.
            logger.error &&
              logger.error(
                JSON.stringify({
                  event: "campaign_captions.auto_confirm_failed",
                  job_id: job.id,
                  campaign_id: campaignId,
                  error_code: error && error.code,
                  error_message: error && error.message,
                })
              );

            return { status: "completed", progress, auto_confirm: "failed" };
          }

          return { status: "completed", progress, auto_confirm: "done" };
        }
      }

      return { status: "completed", progress, auto_confirm: "skipped" };
    } catch (error) {
      const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts || resolveCampaignCaptionsAttempts());

      logger.error &&
        logger.error(
          JSON.stringify({
            event: "campaign_captions.failed",
            job_id: job.id,
            campaign_id: campaignId,
            attempt: job.attemptsMade + 1,
            last_attempt: isLastAttempt,
            error_message: error && error.message,
          })
        );

      // Esgotadas as tentativas, a campanha fica em "gerando_legendas" sem nada
      // que a tire de la - exatamente o estado que antes acontecia em silencio.
      // Avisa na tela para que alguem decida entre regerar e cancelar.
      if (isLastAttempt && inAppNotificationsService.notifyCampaignStuckGeneratingCaptions) {
        await inAppNotificationsService
          .notifyCampaignStuckGeneratingCaptions({
            campaignId,
            campaignName: campaign.nome || campaign.trilha || null,
            reason: `Falha na geracao de legendas apos ${job.attemptsMade + 1} tentativas: ${error && error.message}`,
          })
          .catch((notifyError) => {
            logger.error &&
              logger.error(
                JSON.stringify({
                  event: "campaign_captions.notify_failed",
                  campaign_id: campaignId,
                  error_message: notifyError && notifyError.message,
                })
              );
          });
      }

      throw error;
    }
  };
}

function createCampaignCaptionsWorker(options = {}) {
  const {
    logger = console,
    campaignsRepository,
    campaignVideoCaptionsService,
    settingsService,
    inAppNotificationsService,
    ...workerOptions
  } = options;

  return createWorker(
    queueNames.campaignCaptions,
    createCampaignCaptionsProcessor({
      logger,
      campaignsRepository,
      campaignVideoCaptionsService,
      settingsService,
      inAppNotificationsService,
    }),
    {
      concurrency: resolveCampaignCaptionsConcurrency(),
      lockDuration: resolveCampaignCaptionsLockMs(),
      // Uma unica reentrega apos travamento. A geracao e' retomavel (resume),
      // mas cada rodada custa cota, e um job que trava repetidamente e' um
      // problema para investigar, nao para insistir.
      maxStalledCount: 1,
      ...workerOptions,
    }
  );
}

function createCampaignCaptionsEvents(options = {}) {
  return createQueueEvents(queueNames.campaignCaptions, options);
}

module.exports = {
  CAMPAIGN_CAPTIONS_JOB_NAME,
  CAMPAIGN_STATUS_GENERATING_CAPTIONS,
  DEFAULT_CAMPAIGN_CAPTIONS_ATTEMPTS,
  DEFAULT_CAMPAIGN_CAPTIONS_CONCURRENCY,
  DEFAULT_CAMPAIGN_CAPTIONS_LOCK_MS,
  addCampaignCaptionsJob,
  buildCampaignCaptionsJobData,
  buildCampaignCaptionsJobId,
  createCampaignCaptionsEvents,
  createCampaignCaptionsProcessor,
  createCampaignCaptionsWorker,
  resolveCampaignCaptionsAttempts,
  resolveCampaignCaptionsConcurrency,
  resolveCampaignCaptionsLockMs,
  get campaignCaptionsQueue() {
    return getCampaignCaptionsQueue();
  },
};
