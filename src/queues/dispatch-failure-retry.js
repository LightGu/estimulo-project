const { createQueue, createQueueEvents, createWorker } = require("./bullmq");
const { queueNames } = require("./names");
const { addDispatchJob } = require("./dispatch");
const defaultDispatchLogsRepository = require("../repositories/dispatch-logs.repository");
const defaultGroupsRepository = require("../repositories/groups.repository");
const defaultCampaignsRepository = require("../repositories/campaigns.repository");
const defaultCampaignVideoCaptionsRepository = require("../repositories/campaign-video-captions.repository");
const defaultSettingsService = require("../services/settings.service");
const { resolveLogScheduledAt } = require("../services/dispatch-staleness");

const DISPATCH_FAILURE_RETRY_JOB_NAME = "dispatch-failure-retry-sweep";
const DISPATCH_FAILURE_RETRY_SCHEDULE_KEY = "dispatch-failure-retry-sweep";
const DEFAULT_SWEEP_EVERY_MS = 5 * 60 * 1000;
const MAX_RETRY_ATTEMPTS = 3;
// Teto de reenvios por sweep. Cada reenvio que falha na primeira tentativa gera
// uma notificacao de falha no WhatsApp, entao um backlog acumulado precisa ser
// drenado em lotes ao longo de varios sweeps em vez de tudo de uma vez.
const MAX_RETRIES_PER_SWEEP = 25;
const FAILED_STATUS = "falhou";
// Falhas que nao mudam de resultado ao repetir o mesmo envio. HTTP 413 e o caso
// concreto: o payload em base64 passa do limite de corpo da Evolution API, entao
// cada retry so repete o download do video do Drive e a montagem do mesmo
// payload recusado — ate esgotar MAX_RETRY_ATTEMPTS. Sem legenda aprovada ou com
// credencial/grupo invalidos vale o mesmo raciocinio.
// "Nao confirmou a entrega" tambem entra aqui, e por um motivo diferente dos
// outros: nesse caso a Evolution ACEITOU o envio e a midia ja subiu para o
// WhatsApp. Reenviar nao muda o ACK (para grupo ele simplesmente nao existe - ver
// services/delivery-confirmation.js) e arrisca postar o mesmo video de novo no
// grupo que ja recebeu. Logs antigos com essa mensagem, gravados antes de a regra
// de grupo ser corrigida, sao falso-negativo: precisam ficar de fora do sweep.
// O TIMEOUT entra por exatamente o mesmo motivo que "nao confirmou a entrega":
// a requisicao chegou na Evolution e pode ter sido processada por completo - a
// propria mensagem de erro montada em parseEvolutionError diz "a midia pode ter
// sido entregue mesmo assim". Reenviar nao corrige nada e arrisca postar o mesmo
// video de novo num grupo que ja recebeu, que e' justamente o caso mais provavel
// (video grande e' o que estoura os 180s de mediaTimeoutMs). Decidir repetir um
// envio possivelmente entregue tem de ser uma acao humana, com o log na mao.
//
// EVOLUTION_NO_RESPONSE ("indisponivel ou sem resposta") NAO entra: ali a
// requisicao nao foi aceita, nao ha entrega possivel e reenviar e' correto.
const PERMANENT_FAILURE_PATTERNS = [
  /HTTP 413/i,
  /HTTP 40[0134]/i,
  /HTTP 41[35]/i,
  /HTTP 422/i,
  /excede o limite/i,
  /entity too large/i,
  /nao confirmou a entrega/i,
  /Tempo limite excedido/i,
];

function isPermanentFailureMessage(message) {
  const text = String(message || "");

  return PERMANENT_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

let dispatchFailureRetryQueueInstance;

function getDispatchFailureRetryQueue() {
  if (!dispatchFailureRetryQueueInstance) {
    dispatchFailureRetryQueueInstance = createQueue(queueNames.dispatchFailureRetry);
  }

  return dispatchFailureRetryQueueInstance;
}

async function scheduleDispatchFailureRetrySweep(options = {}) {
  const everyMs = Number(options.every_ms || options.everyMs || DEFAULT_SWEEP_EVERY_MS);

  return getDispatchFailureRetryQueue().add(
    DISPATCH_FAILURE_RETRY_JOB_NAME,
    {},
    {
      repeat: {
        key: DISPATCH_FAILURE_RETRY_SCHEDULE_KEY,
        every: everyMs,
      },
      removeOnComplete: true,
      removeOnFail: true,
    }
  );
}

// Horario original daquele envio, NUNCA "agora".
//
// Antes esta funcao estampava `scheduled_at: new Date()` no job de retry. Isso
// apagava a unica evidencia de que o envio era antigo: a trava de atraso passava
// a comparar o horario contra ele mesmo e sempre autorizava. Um log "falhou" de
// dias atras voltava para a fila como se tivesse sido agendado naquele instante
// e era entregue no grupo - e, como o sweep e re-registrado a cada start dos
// workers, isso se repetia em todo `docker compose up`.
//
// Retorna null quando nao ha horario nenhum para ancorar o retry; nesse caso o
// sweep pula o log em vez de inventar um horario (ver o loop do processor).
// Regra compartilhada com os caminhos de resume - ver dispatch-staleness.js.
const resolveRetryScheduledAt = resolveLogScheduledAt;

// Remonta o job de dispatch a partir do log que falhou.
//
// O reenvio tem de ser o MESMO envio, nao um envio novo para o mesmo grupo.
// Antes, sete campos do job original nao eram reconstruidos aqui - e cada um
// deles mudava o que chegava no grupo:
//
//   whatsapp_instance_id  -> sem ele, resolveInstance(undefined) cai na
//                            primeira instancia disponivel por prioridade. O
//                            reenvio podia sair por um numero diferente do
//                            sorteado pelo rodizio - e, se esse numero nao
//                            participa do grupo, a Evolution responde 200 e o
//                            Baileys descarta em silencio (ver
//                            assertInstanceCoverage em mensagens.service.js).
//                            Pior: updateStatus(..., whatsappInstanceId || null)
//                            gravava null e o relatorio PERDIA o numero que ja
//                            tinha registrado.
//   legenda / caption_id / caption_generated
//                         -> sem eles, resolveDispatchCaption pula o atalho de
//                            "legenda ja revisada na Etapa 2" e chama a IA de
//                            novo. O grupo recebia uma legenda que ninguem
//                            aprovou, e cada reenvio gastava cota do Gemini
//                            (causa conhecida de 429).
//   never_repeat_video / auto_generate_caption / forced_next_video_id
//                         -> regras do disparo, que voltavam ao default.
//
// A fonte de cada um agora e' explicita: instancia e legenda vem do proprio log
// (whatsapp_instance_id) e de campaign_video_captions, resolvidos pelo chamador
// e passados em `context`. Mesma estrategia de
// requeuePendingDispatchJobsForCampaign (campaign-trigger.js), que ja fazia
// certo para o caminho de resume.
function buildRetryJobData(log, context = {}) {
  const group = log.groups || {};
  const video = log.video_catalog || {};
  const caption = context.caption || null;

  return {
    group_id: group.evolution_group_id,
    progress_group_id: log.group_id,
    campaign_id: log.campaign_id,
    video_id: log.video_id,
    trilha_id: group.trilha_id,
    drive_file_id: video.drive_file_id,
    video_catalog: video.drive_file_id ? video : undefined,
    // Sem drive_file_id nem video_id resolvivel via catalogo, cai no link_video
    // legado; resolveDispatchCaption/selectCaptionForVideo escolhem a legenda
    // automaticamente a partir do video_id no reprocessamento.
    link_video: video.drive_file_id ? undefined : video.link_video,
    // O numero que o envio original usou. Sem isto o reenvio trocava de numero
    // e apagava a coluna no relatorio.
    whatsapp_instance_id: log.whatsapp_instance_id || undefined,
    // A legenda que foi aprovada para este par grupo/video, quando existe.
    // Vazio (e nao undefined) mantem o contrato de buildDispatchJobData.
    legenda: (caption && caption.caption_text) || "",
    caption_id: (caption && caption.id) || undefined,
    caption_generated: caption ? true : undefined,
    // Regras do disparo, preservadas do envio original quando o chamador as
    // resolveu; undefined mantem o default de antes.
    never_repeat_video: context.never_repeat_video,
    auto_generate_caption: context.auto_generate_caption,
    // Propagado ate o dispatch worker para que ele so notifique a falha uma vez
    // (na primeira tentativa), em vez de reenviar a mesma notificacao a cada
    // sweep de retry.
    retry_count: log.retry_count || 0,
    scheduled_at: resolveRetryScheduledAt(log),
  };
}

// Varre logs de dispatch com status "falhou" e reenfileira o envio, ate um
// limite de tentativas. Reaproveita o log existente (markRetrying) em vez de
// deixar dispatch-consistency criar um novo attempt log para o mesmo par
// campaign/group/video.
function createDispatchFailureRetryProcessor(options = {}) {
  const {
    dispatchLogsRepository = defaultDispatchLogsRepository,
    groupsRepository = defaultGroupsRepository,
    campaignsRepository = defaultCampaignsRepository,
    campaignVideoCaptionsRepository = defaultCampaignVideoCaptionsRepository,
    settingsService = defaultSettingsService,
    enqueueDispatch = addDispatchJob,
    logger = console,
  } = options;

  // Legendas aprovadas dos pares grupo/video do lote, indexadas por
  // "<group_id>::<video_id>".
  //
  // Sem isto o reenvio gerava uma legenda NOVA pela IA em vez de repetir a que
  // foi aprovada na Etapa 2 - ver o cabecalho de buildRetryJobData. Uma consulta
  // por campanha distinta do lote (nao uma por log), mesma estrategia de
  // filterOutPausedOrCancelledCampaigns.
  async function loadApprovedCaptions(logs) {
    const byKey = new Map();

    if (!logs.length || typeof campaignVideoCaptionsRepository.listByCampaign !== "function") {
      return byKey;
    }

    const campaignIds = [...new Set(logs.map((log) => log.campaign_id).filter(Boolean))];
    const rowsByCampaign = await Promise.all(
      campaignIds.map((campaignId) =>
        campaignVideoCaptionsRepository.listByCampaign(campaignId).catch((error) => {
          // Best-effort: sem a legenda aprovada o reenvio ainda acontece (a IA
          // escolhe uma), entao uma falha aqui nao pode barrar o reprocessamento
          // inteiro. Mas ela precisa aparecer, porque muda o texto que o grupo
          // recebe.
          logger.warn &&
            logger.warn(
              JSON.stringify({
                event: "dispatch_failure_retry.captions_unavailable",
                campaign_id: campaignId,
                error_message: error && error.message,
                note: "reenvio seguira sem a legenda aprovada e podera gerar outra pela IA",
              })
            );

          return [];
        })
      )
    );

    for (const rows of rowsByCampaign) {
      for (const row of rows || []) {
        if (row.status === "gerado" && row.caption_text) {
          byKey.set(`${row.group_id}::${row.video_id}`, row);
        }
      }
    }

    return byKey;
  }

  // Sem isto, o sweep reenfileirava um "falhou" mesmo com a campanha ja
  // pausada/cancelada pelo usuario - o reenvio automatico driblava a acao
  // manual. So busca o status de campanhas distintas do lote, nao uma a uma.
  async function filterOutPausedOrCancelledCampaigns(logs) {
    if (!logs.length || typeof campaignsRepository.findById !== "function") {
      return logs;
    }

    const campaignIds = [...new Set(logs.map((log) => log.campaign_id).filter(Boolean))];
    const campaigns = await Promise.all(
      campaignIds.map((campaignId) => campaignsRepository.findById(campaignId).catch(() => null))
    );
    const statusByCampaignId = new Map(
      campaigns.filter(Boolean).map((campaign) => [campaign.id, campaign.status])
    );

    return logs.filter((log) => {
      const status = statusByCampaignId.get(log.campaign_id);
      return status !== "pausado" && status !== "cancelado";
    });
  }

  return async function dispatchFailureRetryWorker() {
    const dispatchRules = await settingsService.getDispatchRulesSettings();

    if (!dispatchRules.auto_retry_failures) {
      return { checked: 0, retried: 0 };
    }

    // O filtro por retry_count e o teto de itens por sweep vao para o banco: um
    // backlog grande de falhas era carregado inteiro e reenfileirado de uma vez,
    // e cada reenvio que falhava disparava uma notificacao no WhatsApp.
    const failedLogs = await dispatchLogsRepository.listFailedForRetry({
      max_retry_count: MAX_RETRY_ATTEMPTS,
      limit: MAX_RETRIES_PER_SWEEP,
    });
    // Rede de seguranca: o filtro acima ja vem do banco, mas manter a checagem
    // aqui evita reprocessar logs caso a query seja trocada/mockada.
    const permanentLogs = failedLogs.filter((log) => isPermanentFailureMessage(log.mensagem_erro));
    const retryableCandidates = failedLogs
      .filter((log) => (log.retry_count || 0) < MAX_RETRY_ATTEMPTS)
      .filter((log) => !isPermanentFailureMessage(log.mensagem_erro))
      .slice(0, MAX_RETRIES_PER_SWEEP);
    const retryableLogs = await filterOutPausedOrCancelledCampaigns(retryableCandidates);

    for (const log of permanentLogs) {
      logger.warn &&
        logger.warn(
          JSON.stringify({
            event: "dispatch_failure_retry.skipped_permanent",
            log_id: log.id,
            campaign_id: log.campaign_id,
            group_id: log.group_id,
            video_id: log.video_id,
            error_message: log.mensagem_erro,
            note: "falha nao muda de resultado com reenvio identico; exige correcao (ex.: reduzir o video)",
          })
        );
    }

    if (retryableLogs.length >= MAX_RETRIES_PER_SWEEP) {
      logger.warn &&
        logger.warn(
          JSON.stringify({
            event: "dispatch_failure_retry.batch_capped",
            batch_size: retryableLogs.length,
            max_per_sweep: MAX_RETRIES_PER_SWEEP,
            note: "backlog restante sera drenado nos proximos sweeps",
          })
        );
    }

    let retried = 0;
    const captionByKey = await loadApprovedCaptions(retryableLogs);

    for (const log of retryableLogs) {
      try {
        const group = log.groups ? log.groups : await groupsRepository.findById(log.group_id);

        if (!group || !group.evolution_group_id) {
          continue;
        }

        // Sem horario original nao existe como validar o atraso deste reenvio, e
        // inventar "agora" e exatamente o que fazia um envio antigo passar pela
        // trava. Pula e registra: reenviar as cegas nao e uma opcao.
        if (!resolveRetryScheduledAt(log)) {
          logger.warn &&
            logger.warn(
              JSON.stringify({
                event: "dispatch_failure_retry.skipped_sem_horario",
                log_id: log.id,
                campaign_id: log.campaign_id,
                group_id: log.group_id,
                video_id: log.video_id,
                note: "log sem horario_envio_planejado nem criado_em; reenvio exige acao manual",
              })
            );
          continue;
        }

        const nextRetryCount = (log.retry_count || 0) + 1;

        await dispatchLogsRepository.markRetrying(log.id, nextRetryCount);
        await enqueueDispatch(
          {
            ...buildRetryJobData({ ...log, groups: group, retry_count: nextRetryCount }, {
              caption: captionByKey.get(`${log.group_id}::${log.video_id}`) || null,
              never_repeat_video: dispatchRules.never_repeat_video,
              auto_generate_caption: dispatchRules.auto_generate_caption,
            }),
          },
          { removeOnComplete: false, removeOnFail: false }
        );

        retried += 1;

        logger.info &&
          logger.info(
            JSON.stringify({
              event: "dispatch_failure_retry.requeued",
              log_id: log.id,
              campaign_id: log.campaign_id,
              group_id: log.group_id,
              video_id: log.video_id,
              retry_count: nextRetryCount,
            })
          );
      } catch (error) {
        logger.error &&
          logger.error(
            JSON.stringify({
              event: "dispatch_failure_retry.requeue_failed",
              log_id: log.id,
              error_message: error.message,
            })
          );
      }
    }

    return { checked: retryableLogs.length, retried, skipped_permanent: permanentLogs.length };
  };
}

function createDispatchFailureRetryWorker(options = {}) {
  return createWorker(queueNames.dispatchFailureRetry, createDispatchFailureRetryProcessor(options), options);
}

function createDispatchFailureRetryEvents(options = {}) {
  return createQueueEvents(queueNames.dispatchFailureRetry, options);
}

module.exports = {
  DISPATCH_FAILURE_RETRY_JOB_NAME,
  DISPATCH_FAILURE_RETRY_SCHEDULE_KEY,
  MAX_RETRIES_PER_SWEEP,
  MAX_RETRY_ATTEMPTS,
  PERMANENT_FAILURE_PATTERNS,
  buildRetryJobData,
  isPermanentFailureMessage,
  resolveRetryScheduledAt,
  createDispatchFailureRetryProcessor,
  createDispatchFailureRetryWorker,
  createDispatchFailureRetryEvents,
  scheduleDispatchFailureRetrySweep,
  get dispatchFailureRetryQueue() {
    return getDispatchFailureRetryQueue();
  },
};
