const dispatchLogsRepository = require("../repositories/dispatch-logs.repository");
const groupVideoProgressRepository = require("../repositories/group-video-progress.repository");
const campaignsRepository = require("../repositories/campaigns.repository");
const groupsRepository = require("../repositories/groups.repository");
const videoCatalogRepository = require("../repositories/video-catalog.repository");
const defaultSettingsService = require("./settings.service");
// Regra compartilhada com o disparo pontual - ver delivery-confirmation.js.
const { assertDeliveryConfirmed, extractProviderDelivery } = require("./delivery-confirmation");
const { resolveMaxVideoDispatchDelayMs, resolveStaleDispatchReason } = require("./dispatch-staleness");

// Violacao do indice unico parcial idx_logs_trio_ativo (migration 202609070002).
//
// O Postgres devolve 23505; o Postgrest repassa o codigo e cita o nome do
// indice na mensagem. Casar tambem pelo nome evita tratar como corrida do trio
// uma violacao de OUTRA constraint unica que venha a existir na tabela.
const UNIQUE_VIOLATION_CODE = "23505";
const TRIO_UNIQUE_INDEX_NAME = "idx_logs_trio_ativo";

function isUniqueTrioViolation(error) {
  if (!error) {
    return false;
  }

  if (String(error.code) !== UNIQUE_VIOLATION_CODE) {
    return false;
  }

  const haystack = `${error.message || ""} ${error.details || ""} ${error.hint || ""}`;

  // Sem mencao a indice nenhum, assume que e' o do trio: e' a unica constraint
  // unica que este caminho de insercao pode violar hoje.
  return !/idx_logs_/i.test(haystack) || haystack.includes(TRIO_UNIQUE_INDEX_NAME);
}

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

  // Log do trio, filtrado NO BANCO.
  //
  // Antes esta funcao carregava todos os logs da campanha (listByCampaign,
  // select("*") sem limite) e reduzia em memoria. Executada tres vezes por
  // envio, era o maior custo do caminho critico - e, pior, ficava exposta ao
  // teto de linhas do PostgREST: acima dele o resultado e' truncado em
  // silencio, comecando pelas linhas mais antigas (a ordem era criado_em DESC),
  // que sao exatamente os logs "enviado" que esta checagem precisa encontrar
  // para NAO reenviar. Ver findByTrio em dispatch-logs.repository.js.
  //
  // Mantem o fallback para o caminho antigo porque varios testes injetam um
  // repositorio falso que so implementa listByCampaign.
  async function findExistingLog(campaignId, groupId, videoId, statuses = ["pendente", "processando", "enviado", "falhou"]) {
    if (typeof dispatchLogsRepositoryDependency.findByTrio === "function") {
      return dispatchLogsRepositoryDependency.findByTrio(campaignId, groupId, videoId, statuses);
    }

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

  // As tres etapas abaixo - buscar log "processando", buscar "pendente", criar -
  // sao round-trips separados, sem atomicidade entre si. Dois produtores podem
  // passar pelas buscas antes de qualquer um criar, e cada um cria a SUA linha
  // em `logs`. Como o claimForSend seguinte e' um compare-and-set por `id` de
  // LINHA, os dois claims tem sucesso: o CAS protege uma linha, nao o trio
  // logico campanha/grupo/video. Resultado: o mesmo video postado duas vezes.
  //
  // Isso NAO exigia escalar nada para acontecer, ao contrario do que este
  // comentario dizia antes: a corrida entre ensurePendingDispatchLogs (que lia
  // a lista de logs uma vez e decidia contra um array em memoria) e este
  // createAttemptLog bastava, com um unico worker - o primeiro job de disparo
  // sai com delay 0 e chega aqui enquanto o trigger ainda percorre os outros
  // grupos inserindo. A linha perdedora ficava presa em "pendente" para sempre.
  //
  // A defesa nao esta mais na ordem de execucao: o indice unico parcial
  // idx_logs_trio_ativo (migration 202609070002) torna o segundo INSERT um erro
  // 23505, e o catch abaixo rele o log vencedor em vez de propagar. O resultado
  // passa a ser o mesmo independente de quem chegou primeiro - o que tambem
  // libera `--scale dispatch-worker=N` / concurrency > 1, antes bloqueados por
  // esta janela. O retry (markRetrying) reutiliza o log existente, entao ja era
  // compativel com o indice.
  async function createAttemptLog(payload) {
    const existing = await findExistingLog(payload.campaignId, payload.groupId, payload.videoId, ["processando"]);

    if (existing) {
      return { log: existing, created: false, skipSend: true };
    }

    const existingPending = await findExistingLog(payload.campaignId, payload.groupId, payload.videoId, ["pendente"]);

    if (existingPending) {
      return { log: existingPending, created: false, skipSend: false };
    }

    try {
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
        // Correlacao: o job que originou esta tentativa carrega o mesmo valor.
        dispatch_ref: payload.dispatchRef || null,
      });

      return { log, created: true, skipSend: false };
    } catch (error) {
      if (!isUniqueTrioViolation(error)) {
        throw error;
      }

      // Perdemos a corrida: outro produtor criou o log deste trio entre as
      // buscas acima e este INSERT, e o indice unico idx_logs_trio_ativo
      // (migration 202609070002) recusou a duplicata. Rele o vencedor e siga
      // com ELE - o envio continua acontecendo uma unica vez, por quem detiver
      // o claim.
      const winner = await findExistingLog(payload.campaignId, payload.groupId, payload.videoId, [
        "pendente",
        "processando",
        "enviado",
      ]);

      writeStageLog(logger, "info", "dispatch_consistency.attempt_log_race_lost", {
        campaign_id: payload.campaignId,
        group_id: payload.groupId,
        video_id: payload.videoId,
        log_id: winner && winner.id,
        winner_status: winner && winner.status,
        note: "indice unico do trio recusou a linha duplicada; seguindo com o log existente",
      });

      if (!winner) {
        // O indice recusou mas nada foi encontrado: so acontece se o vencedor
        // saiu de um estado ativo nesse meio-tempo. Propaga - e' recuperavel
        // pelo sweep de retry e nao arrisca envio duplicado.
        throw error;
      }

      return {
        log: winner,
        created: false,
        // "processando"/"enviado" ja tem envio em andamento ou concluido: nao
        // reenviar. "pendente" segue para o claim, que decide quem envia.
        skipSend: winner.status !== "pendente",
      };
    }
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
      windowEnd,
      whatsappInstanceId,
      dispatchRef,
    } = options;

    writeStageLog(logger, "info", "dispatch_consistency.ensure_entities.started", {
      campaign_id: campaignId,
      group_id: groupId,
      video_id: videoId,
      dispatch_ref: dispatchRef,
    });
    const { campaign } = await ensureDispatchEntities(campaignId, groupId, videoId);
    writeStageLog(logger, "info", "dispatch_consistency.ensure_entities.completed", {
      campaign_id: campaignId,
      group_id: groupId,
      video_id: videoId,
      dispatch_ref: dispatchRef,
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
      dispatch_ref: dispatchRef,
    });
    const completedLog = await findExistingLog(campaignId, groupId, videoId, ["enviado"]);
    writeStageLog(logger, "info", "dispatch_consistency.find_completed_log.completed", {
      campaign_id: campaignId,
      group_id: groupId,
      video_id: videoId,
      dispatch_ref: dispatchRef,
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
      dispatch_ref: dispatchRef,
    });
    const { log, skipSend } = await createAttemptLog({
      campaignId,
      groupId,
      videoId,
      scheduledAt,
      dispatchRef,
    });
    writeStageLog(logger, "info", "dispatch_consistency.create_attempt_log.completed", {
      campaign_id: campaignId,
      group_id: groupId,
      video_id: videoId,
      dispatch_ref: dispatchRef,
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
      // E a janela do usuario por cima do teto: enquanto o horario de FIM nao
      // chegou, entregar continua sendo exatamente o que foi pedido. Sem isto o
      // teto de 6h cancelava a cauda de campanhas grandes por um atraso que o
      // proprio processamento serial produziu.
      windowEnd,
    });

    if (staleReason) {
      writeStageLog(logger, "warn", "dispatch_consistency.cancelled_stale", {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
        dispatch_ref: dispatchRef,
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
      dispatch_ref: dispatchRef,
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
        dispatch_ref: dispatchRef,
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
      dispatch_ref: dispatchRef,
      log_id: log.id,
    });

    try {
      writeStageLog(logger, "info", "dispatch_consistency.sender.started", {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
        dispatch_ref: dispatchRef,
        log_id: log.id,
      });
      const result = await sender(deliveryPayload);
      writeStageLog(logger, "info", "dispatch_consistency.sender.completed", {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
        dispatch_ref: dispatchRef,
        log_id: log.id,
      });
      assertDeliveryConfirmed(result);

      writeStageLog(logger, "info", "dispatch_consistency.mark_sent.started", {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
        dispatch_ref: dispatchRef,
        log_id: log.id,
      });
      await dispatchLogsRepositoryDependency.updateStatus(log.id, "enviado", null, whatsappInstanceId || null);
      writeStageLog(logger, "info", "dispatch_consistency.mark_sent.completed", {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
        dispatch_ref: dispatchRef,
        log_id: log.id,
      });

      await recordProviderDelivery(log.id, result, {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
        dispatch_ref: dispatchRef,
      });

      writeStageLog(logger, "info", "dispatch_consistency.progress.started", {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
        dispatch_ref: dispatchRef,
        log_id: log.id,
      });
      const progress = await registerProgress(groupId, videoId, trilhaId, { neverRepeatVideo, forcedNextVideoId });
      writeStageLog(logger, "info", "dispatch_consistency.progress.completed", {
        campaign_id: campaignId,
        group_id: groupId,
        video_id: videoId,
        dispatch_ref: dispatchRef,
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
        dispatch_ref: dispatchRef,
        log_id: log.id,
        error_message: error.message || String(error),
      });
      await markCampaignFailed(campaignId);
      await dispatchLogsRepositoryDependency.updateStatus(
        log.id,
        "falhou",
        error.message || String(error),
        whatsappInstanceId || null
      );
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
