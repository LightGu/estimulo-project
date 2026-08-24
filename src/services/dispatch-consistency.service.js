const dispatchLogsRepository = require("../repositories/dispatch-logs.repository");
const groupVideoProgressRepository = require("../repositories/group-video-progress.repository");
const campaignsRepository = require("../repositories/campaigns.repository");
const groupsRepository = require("../repositories/groups.repository");
const videoCatalogRepository = require("../repositories/video-catalog.repository");
const defaultSettingsService = require("./settings.service");
// Regra compartilhada com o disparo pontual - ver delivery-confirmation.js.
const { assertDeliveryConfirmed, extractProviderDelivery } = require("./delivery-confirmation");
const { resolveMaxVideoDispatchDelayMs, resolveStaleDispatchReason } = require("./dispatch-staleness");

function writeStageLog(logger, level, event, payload = {}) {
  const writer = logger && (logger[level] || logger.info);

  if (typeof writer !== "function") {
    return;
  }

  writer.call(logger, JSON.stringify({ event, ...payload }));
}

function createDispatchConsistencyService(dependencies = {}) {
  const dispatchLogsRepositoryDependency = dependencies.dispatchLogsRepository || dispatchLogsRepository;
  const groupVideoProgressRepositoryDependency = dependencies.groupVideoProgressRepository || groupVideoProgressRepository;
  const campaignsRepositoryDependency = dependencies.campaignsRepository || campaignsRepository;
  const groupsRepositoryDependency = dependencies.groupsRepository || groupsRepository;
  const videoCatalogRepositoryDependency = dependencies.videoCatalogRepository || videoCatalogRepository;
  const settingsService = dependencies.settingsService || defaultSettingsService;
  const logger = dependencies.logger || console;

  async function ensureDispatchEntities(campaignId, groupId, videoId) {
    if (!campaignId) {
      throw new Error("Campaign id is required");
    }

    if (!groupId) {
      throw new Error("Group id is required");
    }

    const campaign = await campaignsRepositoryDependency.findById(campaignId);

    if (!campaign) {
      throw new Error("Campaign not found");
    }

    const group = await groupsRepositoryDependency.findById(groupId);

    if (!group) {
      throw new Error("Group not found");
    }

    if (!videoId) {
      return { campaign, group };
    }

    const video = await videoCatalogRepositoryDependency.findById(videoId);

    if (!video) {
      throw new Error("Video not found");
    }

    return { campaign, group, video };
  }

  async function findExistingLog(campaignId, groupId, videoId, statuses = ["pendente", "processando", "enviado", "falhou"]) {
    const logs = await dispatchLogsRepositoryDependency.listByCampaign(campaignId);

    return (logs || []).find((entry) => {
      if (entry.group_id !== groupId) {
        return false;
      }

      if (videoId && entry.video_id !== videoId) {
        return false;
      }

      return statuses.includes(entry.status);
    }) || null;
  }

  // LIMITACAO CONHECIDA (segura na configuracao atual, perigosa se escalar).
  //
  // As tres etapas abaixo - buscar log "processando", buscar "pendente", criar -
  // sao round-trips separados, sem atomicidade. Com DOIS workers de dispatch
  // rodando, ambos podem passar pelas buscas antes de qualquer um criar, e cada
  // um cria a SUA linha em `logs`. Como o claimForSend seguinte e' um
  // compare-and-set por `id` de linha, os dois claims tem sucesso: o CAS protege
  // uma linha, nao o trio logico campanha/grupo/video. Resultado: o mesmo video
  // postado duas vezes no grupo.
  //
  // Por que e' seguro hoje: infra/docker-compose.yml declara UMA instancia de
  // dispatch-worker (sem deploy.replicas) e a BullMQ usa concurrency 1 por
  // padrao - nenhum dos dois e' sobrescrito no projeto. A serializacao e'
  // operacional, nao estrutural.
  //
  // ANTES DE ESCALAR (`--scale dispatch-worker=N` ou concurrency > 1) e preciso:
  //   1. auditar duplicatas historicas em `logs` para o trio
  //      (campaign_id, group_id, video_id) - o indice abaixo falha se existirem;
  //   2. criar o indice unico parcial:
  //      CREATE UNIQUE INDEX CONCURRENTLY idx_logs_trio_ativo
  //        ON public.logs (campaign_id, group_id, video_id)
  //        WHERE status IN ('pendente','processando','enviado');
  //   3. tratar a violacao aqui, relendo o log vencedor em vez de propagar o erro;
  //   4. reverificar requeuePendingDispatchJobsForCampaign (campaign-trigger.js),
  //      que reenfileira para o mesmo trio.
  // O retry (markRetrying em dispatch-logs.repository.js) reutiliza o log
  // existente, entao ja e' compativel com o indice.
  async function createAttemptLog(payload) {
    const existing = await findExistingLog(payload.campaignId, payload.groupId, payload.videoId, ["processando"]);

    if (existing) {
      return { log: existing, created: false, skipSend: true };
    }

    const existingPending = await findExistingLog(payload.campaignId, payload.groupId, payload.videoId, ["pendente"]);

    if (existingPending) {
      return { log: existingPending, created: false, skipSend: false };
    }

    const log = await dispatchLogsRepositoryDependency.createLog({
      campaign_id: payload.campaignId,
      group_id: payload.groupId,
      video_id: payload.videoId,
      status: "pendente",
      mensagem_erro: null,
      // Grava o horario do job. Sem isto o log nascia com
      // horario_envio_planejado NULL - a origem dos "logs orfaos" que apareciam
      // no relatorio com "-" e, pior, que faziam todo caminho de resume/retry
      // reenfileirar o envio sem nenhum horario em que ancorar a trava de
      // atraso (o default `new Date()` assumia e o envio antigo saia como novo).
      horario_envio_planejado: payload.scheduledAt || null,
    });

    return { log, created: true, skipSend: false };
  }

  async function registerProgress(groupId, videoId, trilhaId, options = {}) {
    if (!groupId || !videoId) {
      return null;
    }

    const duplicate = await groupVideoProgressRepositoryDependency.hasDuplicate(groupId, videoId);
    let record = null;
    let skippedProgress = false;

    if (duplicate) {
      if (options.neverRepeatVideo === false) {
        record = await groupVideoProgressRepositoryDependency.upsertDelivery({
          group_id: groupId,
          video_id: videoId,
          trilha_id: trilhaId || null,
        });
      } else {
        skippedProgress = true;
      }
    } else {
      record = await groupVideoProgressRepositoryDependency.registerDelivery({
        group_id: groupId,
        video_id: videoId,
        trilha_id: trilhaId || null,
      });
    }

    // A mensagem ja foi enviada mesmo quando o registro de progresso e pulado
    // (repeticao com "nunca repetir video" ativo) - o forced_next_video_id
    // precisa ser limpo de qualquer forma, senao o proximo disparo tenta
    // reenviar o mesmo video forcado indefinidamente.
    const groupUpdate = { ...(trilhaId ? { trilha_id: trilhaId } : {}) };

    if (options.forcedNextVideoId && options.forcedNextVideoId === videoId) {
      groupUpdate.forced_next_video_id = null;
    }

    if (Object.keys(groupUpdate).length > 0) {
      await groupsRepositoryDependency.update(groupId, groupUpdate);
    }

    if (skippedProgress) {
      return { duplicate: true, record: null };
    }

    return { duplicate: false, record };
  }

  // Best-effort: a mensagem ja saiu e o log ja esta "enviado". Se o registro da
  // evidencia falhar, perde-se a rastreabilidade daquele envio - nunca o envio.
  async function recordProviderDelivery(logId, result, context = {}) {
    if (!logId || typeof dispatchLogsRepositoryDependency.updateProviderDelivery !== "function") {
      return;
    }

    try {
      await dispatchLogsRepositoryDependency.updateProviderDelivery(logId, extractProviderDelivery(result));
    } catch (error) {
      writeStageLog(logger, "error", "dispatch_consistency.record_provider_delivery_failed", {
        ...context,
        log_id: logId,
        error_message: error.message || String(error),
      });
    }
  }

  async function markCampaignFailed(campaignId) {
    let autoRetryFailures = false;

    try {
      const dispatchRules = await settingsService.getDispatchRulesSettings();
      autoRetryFailures = Boolean(dispatchRules.auto_retry_failures);
    } catch (error) {
      // Antes assumia `false` em silencio, e `false` e' justamente o valor que
      // DESATIVA a campanha logo abaixo. Ou seja: uma falha de leitura das
      // settings derrubava a campanha inteira e o sweep de retry parava de
      // reprocessa-la, sem log nenhum. Assumir `true` mantem a campanha viva e
      // deixa a decisao com o worker de retry, que e' o comportamento
      // recuperavel; a falha agora aparece no log.
      autoRetryFailures = true;

      writeStageLog(logger, "error", "dispatch_consistency.dispatch_rules_unavailable", {
        campaign_id: campaignId,
        assumed_auto_retry_failures: true,
        error_message: error && error.message,
      });
    }

    // Quando o reprocessamento automatico de falhas esta ativo, o worker de retry
    // (dispatch-failure-retry.js) e quem decide o destino do log "falhou"; manter a
    // campanha ativa evita que ela seja desativada antes do proximo reprocessamento.
    if (autoRetryFailures) {
      return;
    }

    if (campaignsRepositoryDependency && typeof campaignsRepositoryDependency.update === "function") {
      await campaignsRepositoryDependency.update(campaignId, { ativo: false });
    }
  }

  async function executeDispatch(options = {}) {
    const {
      campaignId,
      groupId,
      videoId,
      trilhaId,
      sender,
      deliveryPayload,
      neverRepeatVideo,
      forcedNextVideoId,
      scheduledAt,
    } = options;

    writeStageLog(logger, "info", "dispatch_consistency.ensure_entities.started", {
      campaign_id: campaignId,
      group_id: groupId,
      video_id: videoId,
    });
    const { campaign } = await ensureDispatchEntities(campaignId, groupId, videoId);
    writeStageLog(logger, "info", "dispatch_consistency.ensure_entities.completed", {
      campaign_id: campaignId,
      group_id: groupId,
      video_id: videoId,
    });

    // Pausa/cancelamento nao mudam o status do log de disparo pendente (fica
    // pendente para o resume conseguir retomar, ou e cancelado em lote sem
    // vinculo com o job do BullMQ que ja estava enfileirado com delay) - so o
    // claim atomico la na frente nao bastaria para impedir o envio, e sem esta
    // checagem aqui um job de campanha ja cancelada (que sobreviveu no Redis e
    // so roda quando a infra do worker volta a subir) reencontra o log como
    // "nao existe mais pendente/processando" e cria um novo log do zero,
    // reenviando por cima do cancelamento.
    if (campaign && (campaign.status === "pausado" || campaign.status === "cancelado")) {
      return {
        idempotent: true,
        status: campaign.status,
        skippedSend: true,
        logId: null,
      };
    }

    writeStageLog(logger, "info", "dispatch_consistency.find_completed_log.started", {
      campaign_id: campaignId,
      group_id: groupId,
      video_id: videoId,
    });
    const completedLog = await findExistingLog(campaignId, groupId, videoId, ["enviado"]);
    writeStageLog(logger, "info", "dispatch_consistency.find_completed_log.completed", {
      campaign_id: campaignId,
      group_id: groupId,
      video_id: videoId,
      log_id: completedLog && completedLog.id,
    });

    if (completedLog) {
      return {
        idempotent: true,
        status: "enviado",
        skippedSend: true,
        logId: completedLog.id,
      };
    }

    writeStageLog(logger, "info", "dispatch_consistency.create_attempt_log.started", {
      campaign_id: campaignId,
      group_id: groupId,
      video_id: videoId,
    });
    const { log, skipSend } = await createAttemptLog({
      campaignId,
      groupId,
      videoId,
      scheduledAt,
    });
    writeStageLog(logger, "info", "dispatch_consistency.create_attempt_log.completed", {
      campaign_id: campaignId,
      group_id: groupId,
      video_id: videoId,
      log_id: log && log.id,
      skipped_send: skipSend,
    });

    if (skipSend) {
      return {
        idempotent: true,
        status: "processando",
        skippedSend: true,
        logId: log.id,
      };
    }

    // Trava de atraso: um dispatch que so roda muito depois do horario
    // planejado do log (fila parada, worker que caiu e voltou, resume de
    // campanha pausada ha muito tempo) nao pode disparar por cima do horario
    // perdido - cancela em vez de mandar video "atrasado" sem contexto.
    //
    // O fallback para scheduledAt (horario do job) e essencial: createAttemptLog
    // cria o log sem horario_envio_planejado, entao sozinho ele deixava esta
    // trava cega em todo primeiro envio de um par campanha/grupo/video.
    const staleReason = resolveStaleDispatchReason(log.horario_envio_planejado || scheduledAt, {
      // Mesmo teto generoso do worker de video (ver dispatch-staleness.js): com
      // concorrencia 1 os ultimos grupos de uma campanha grande acumulam atraso
      // legitimo, e o teto de 30 min do envio pontual cancelaria esses envios.
      maxDelayMs: resolveMaxVideoDispatchDelayMs(),
    });

    if (staleReason) {
      writeStageLog(logger, "warn", "dispatch_consistency.cancelled_stale", {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
        log_id: log.id,
        scheduled_at: log.horario_envio_planejado,
        reason: staleReason,
      });

      const cancelled = await dispatchLogsRepositoryDependency.cancelIfPending(log.id, staleReason);

      if (!cancelled) {
        writeStageLog(logger, "info", "dispatch_consistency.cancel_stale_lost", {
          campaign_id: campaignId,
          group_id: groupId,
          video_id: videoId,
          log_id: log.id,
        });
      } else {
        return {
          idempotent: true,
          status: "cancelado",
          skippedSend: true,
          logId: log.id,
        };
      }
    }

    writeStageLog(logger, "info", "dispatch_consistency.mark_processing.started", {
      campaign_id: campaignId,
      group_id: groupId,
      video_id: videoId,
      log_id: log.id,
    });
    // Reivindicacao atomica (so avanca se o log ainda estiver pendente): fecha
    // a corrida entre um job antigo que sobreviveu a uma pausa e o job novo
    // criado no resume para o mesmo log, e tambem cobre cancelamento (o log ja
    // virou "cancelado" antes deste ponto, entao o claim falha e nao envia).
    const claimedLog = await dispatchLogsRepositoryDependency.claimForSend(log.id);

    if (!claimedLog) {
      writeStageLog(logger, "info", "dispatch_consistency.claim_lost", {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
        log_id: log.id,
      });

      return {
        idempotent: true,
        status: "skipped",
        skippedSend: true,
        logId: log.id,
      };
    }

    writeStageLog(logger, "info", "dispatch_consistency.mark_processing.completed", {
      campaign_id: campaignId,
      group_id: groupId,
      video_id: videoId,
      log_id: log.id,
    });

    try {
      writeStageLog(logger, "info", "dispatch_consistency.sender.started", {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
        log_id: log.id,
      });
      const result = await sender(deliveryPayload);
      writeStageLog(logger, "info", "dispatch_consistency.sender.completed", {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
        log_id: log.id,
      });
      assertDeliveryConfirmed(result);

      writeStageLog(logger, "info", "dispatch_consistency.mark_sent.started", {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
        log_id: log.id,
      });
      await dispatchLogsRepositoryDependency.updateStatus(log.id, "enviado");
      writeStageLog(logger, "info", "dispatch_consistency.mark_sent.completed", {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
        log_id: log.id,
      });

      await recordProviderDelivery(log.id, result, {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
      });

      writeStageLog(logger, "info", "dispatch_consistency.progress.started", {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
        log_id: log.id,
      });
      const progress = await registerProgress(groupId, videoId, trilhaId, { neverRepeatVideo, forcedNextVideoId });
      writeStageLog(logger, "info", "dispatch_consistency.progress.completed", {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
        log_id: log.id,
        duplicate: Boolean(progress && progress.duplicate),
      });

      return {
        idempotent: false,
        status: "enviado",
        skippedSend: false,
        logId: log.id,
        progress,
        result,
      };
    } catch (error) {
      writeStageLog(logger, "error", "dispatch_consistency.failed", {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
        log_id: log.id,
        error_message: error.message || String(error),
      });
      await markCampaignFailed(campaignId);
      await dispatchLogsRepositoryDependency.updateStatus(log.id, "falhou", error.message || String(error));
      throw error;
    }
  }

  return {
    executeDispatch,
  };
}

module.exports = createDispatchConsistencyService();
module.exports.createDispatchConsistencyService = createDispatchConsistencyService;
module.exports.assertDeliveryConfirmed = assertDeliveryConfirmed;
