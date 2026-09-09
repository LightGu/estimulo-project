const groupsRepository = require("../repositories/groups.repository");
const campaignsRepository = require("../repositories/campaigns.repository");
const campaignGroupsRepository = require("../repositories/campaign-groups.repository");
const dispatchLogsRepository = require("../repositories/dispatch-logs.repository");
const { sendToEvolution } = require("./evolution");
const { resolveInstance, resolveInstanceSender } = require("./evolution-instance-sender");
const { assertDeliveryConfirmed, confirmProviderDelivery, extractProviderDelivery } = require("./delivery-confirmation");
const { assertNoCampaignWindowConflict } = require("./campaign-window-conflict");
const { resolveLogScheduledAt } = require("./dispatch-staleness");
const { buildJitteredDispatchSchedule, resolveInstanceForOrder } = require("../queues/dispatch-jitter");
const { addMensagensDispatchJob } = require("../queues/mensagens-dispatch");
const defaultSettingsService = require("./settings.service");
const defaultWhatsappInstancesRepository = require("../repositories/whatsapp-instances.repository");
const defaultWhatsappInstancesService = require("./whatsapp-instances.service");
const { formatAdHocCampaignName, formatDateOnlyInTimezone } = require("../utils/campaign-naming");
const { prepareAdHocMediaContent } = require("./adhoc-media");
const { putMediaInSpool } = require("./media-spool");

const CLASSIFICACOES = ["evento", "credito", "pesquisa", "aviso", "capacitacao", "outro"];

function normalizeGroupIds(payload = {}) {
  return Array.isArray(payload.group_ids) ? [...new Set(payload.group_ids.filter(Boolean))] : [];
}

// Anexo enviado via upload (Disparador Pontual com midia) ja chega pronto do
// controller como { base64, mimeType, fileName, type } - sem link nem
// tipo_conteudo, e sem nunca ter passado por disco ou banco.
function normalizeUploadedContent(payload) {
  const base64 = typeof payload.content?.base64 === "string" ? payload.content.base64 : "";

  if (!base64) {
    return null;
  }

  return {
    content: {
      base64,
      mimeType: payload.content.mimeType,
      fileName: payload.content.fileName,
      type: payload.content.type === "video" ? "video" : "image",
    },
    tipoConteudo: payload.content.type === "video" ? "video" : "imagem",
  };
}

function normalizeContent(payload = {}) {
  const texto = typeof payload.texto === "string" ? payload.texto.trim() : "";
  const uploaded = normalizeUploadedContent(payload);

  if (uploaded) {
    return { texto, content: uploaded.content, tipoConteudo: uploaded.tipoConteudo };
  }

  const link = typeof payload.link === "string" ? payload.link.trim() : "";
  const tipoConteudo = payload.tipo_conteudo || "texto";

  if (!texto && !link) {
    throw new Error("Informe um texto ou um link de conteudo");
  }

  const content = link
    ? {
        url: link,
        type: tipoConteudo === "documento" ? "document" : tipoConteudo === "video" ? "video" : "image",
      }
    : undefined;

  return { texto, content, tipoConteudo: link ? tipoConteudo : null };
}

// Teto de envios simultaneos do disparo pontual sincrono.
//
// Antes era Promise.all sobre a lista inteira de grupos: 30 grupos = 30
// requisicoes concorrentes a Evolution, cada uma serializando a MESMA midia em
// base64 (ate ~136 MB por payload). Dois problemas de uma vez - pico de heap
// multiplicado pelo numero de grupos, e uma rajada simultanea pelo mesmo numero,
// que e' o padrao que o WhatsApp trata como spam. O jitter existe no caminho de
// campanha exatamente para evitar isso, e aqui nao existia teto nenhum.
const DEFAULT_ADHOC_DISPATCH_CONCURRENCY = 2;

function resolveAdHocDispatchConcurrency() {
  const configured = Number(process.env.ADHOC_DISPATCH_CONCURRENCY);

  if (!Number.isFinite(configured) || configured < 1) {
    return DEFAULT_ADHOC_DISPATCH_CONCURRENCY;
  }

  return Math.trunc(configured);
}

// Executa `worker` sobre `items` com no maximo `limit` em voo, preservando a
// ordem do resultado. Nunca rejeita: quem chama trata o desfecho item a item
// (aqui, gravando "enviado"/"falhou" no log daquele grupo).
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runNext() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));

  return results;
}

function normalizeClassificacao(payload = {}) {
  const classificacao = typeof payload.tipo === "string" ? payload.tipo.trim() : "";

  return CLASSIFICACOES.includes(classificacao) ? classificacao : null;
}

function normalizeTitulo(payload = {}) {
  const titulo = typeof payload.titulo === "string" ? payload.titulo.trim() : "";

  return titulo || null;
}

function createMensagensService(dependencies = {}) {
  const repository = dependencies.groupsRepository || groupsRepository;
  const campaigns = dependencies.campaignsRepository || campaignsRepository;
  const campaignGroups = dependencies.campaignGroupsRepository || campaignGroupsRepository;
  const dispatchLogs = dependencies.dispatchLogsRepository || dispatchLogsRepository;
  const buildSchedule = dependencies.buildJitteredDispatchSchedule || buildJitteredDispatchSchedule;
  const enqueue = dependencies.addMensagensDispatchJob || addMensagensDispatchJob;
  const confirmDelivery = dependencies.confirmProviderDelivery || confirmProviderDelivery;
  const settingsService = dependencies.settingsService || defaultSettingsService;
  const whatsappInstances = dependencies.whatsappInstancesRepository || defaultWhatsappInstancesRepository;
  // Sem sendToEvolution explicito nas dependencias (uso real, fora de teste),
  // resolve a instancia pelo mesmo caminho do envio agendado/via fila
  // (resolveInstanceSender): a primeira instancia ativa por prioridade - nunca
  // o nome fixo em EVOLUTION_INSTANCE_NAME. O disparo imediato (POST
  // /mensagens/dispatch, usado pelo botao "Enviar teste para este grupo")
  // chamava sendToEvolution direto e por isso continuava batendo na instancia
  // removida, mesmo depois da mesma correcao ja ter sido aplicada no caminho
  // agendado/via fila. O disparo imediato nao associa grupo a instancia (isso
  // so existe na rotacao do envio agendado, resolveInstanceForOrder).
  const resolveSender = dependencies.resolveInstanceSender || resolveInstanceSender;
  const send = dependencies.sendToEvolution
    || (async (params) => (await resolveSender(undefined, { whatsappInstancesRepository: whatsappInstances }))(params));
  const whatsappInstancesService = dependencies.whatsappInstancesService || defaultWhatsappInstancesService;
  const logger = dependencies.logger || console;
  // Recomprime/remuxa o anexo de video antes de qualquer envio ou enfileiramento.
  // Injetavel para os testes nao dependerem do ffmpeg.
  const prepareMedia = dependencies.prepareAdHocMediaContent || prepareAdHocMediaContent;
  const depositMedia = dependencies.putMediaInSpool || putMediaInSpool;

  async function resolveGroups(groupIds) {
    return Promise.all(groupIds.map((groupId) => repository.findById(groupId)));
  }

  // Com TODOS os numeros pausados nao ha por onde enviar. Sem esta checagem o
  // disparador aceitaria a requisicao e so falharia la na frente, no envio de
  // cada grupo - ou pior, cairia no sender fixo do .env e furaria a pausa.
  // Falha cedo, com mensagem que diz o que fazer.
  async function assertAnyInstanceDispatchable() {
    if (typeof whatsappInstancesService.listDispatchableInstances !== "function") {
      return;
    }

    const [dispatchable, all] = await Promise.all([
      whatsappInstancesService.listDispatchableInstances(),
      typeof whatsappInstances.listActive === "function" ? whatsappInstances.listActive() : [],
    ]);

    if ((dispatchable || []).length > 0 || (all || []).length === 0) {
      return;
    }

    const error = new Error(
      "Todos os números de WhatsApp estão pausados. Despause ao menos um número em Configurações para enviar mensagens."
    );
    error.code = "ALL_INSTANCES_PAUSED";
    throw error;
  }

  // Mesma regra do caminho de video (filterGroupsMissingInstanceCoverage em
  // queues/campaign-trigger.js): com 2+ numeros ativos, um grupo que nao esteja
  // vinculado a todos eles pode cair, no rodizio, em um numero que nao participa
  // do grupo. A Evolution aceita a requisicao e responde 200; o Baileys descarta
  // em silencio e o log fica "enviado" sem entrega. Aqui o erro e duro (e nao um
  // skip como na campanha) porque os grupos vieram de uma escolha explicita do
  // usuario nesta tela - pular em silencio esconderia justamente o problema.
  async function assertInstanceCoverage(groups) {
    if (typeof whatsappInstancesService.filterDispatchableGroups !== "function") {
      return;
    }

    const { ineligible } = await whatsappInstancesService.filterDispatchableGroups(groups.map((group) => group.id));

    if (!ineligible || !ineligible.length) {
      return;
    }

    const ineligibleSet = new Set(ineligible);
    const nomes = groups.filter((group) => ineligibleSet.has(group.id)).map((group) => group.nome || group.id);

    throw new Error(`Grupo(s) sem vinculo com todos os numeros de WhatsApp ativos: ${nomes.join(", ")}`);
  }

  // Fecha o log pendente de um grupo do disparo pontual sincrono com o desfecho
  // real do envio.
  //
  // Best-effort, e por um motivo especifico: quando esta funcao roda, a mensagem
  // ja esta (ou nao esta) no grupo, e esse fato nao muda mais. Propagar um erro
  // de banco daqui transformaria um envio bem-sucedido em erro na resposta.
  // Mas a falha nao pode ser muda: um log preso em "pendente" nao tem job
  // apontando para ele e nenhum worker vai alcanca-lo, entao o evento abaixo e'
  // a unica pista de que aquele envio precisa de conciliacao manual.
  async function updateAdHocLogOutcome(log, status, mensagemErro, whatsappInstanceId) {
    if (!log || !log.id || typeof dispatchLogs.updateStatus !== "function") {
      return;
    }

    try {
      await dispatchLogs.updateStatus(log.id, status, mensagemErro || null, whatsappInstanceId || null);
    } catch (error) {
      logger.error &&
        logger.error(
          JSON.stringify({
            event: "mensagens.ad_hoc_log_outcome_failed",
            dispatch_log_id: log.id,
            campaign_id: log.campaign_id || null,
            group_id: log.group_id || null,
            intended_status: status,
            note: "log ficou preso em pendente apesar do envio ter desfecho conhecido; exige conciliacao manual",
            error_message: error?.message,
          })
        );
    }
  }

  // Best-effort: a mensagem ja saiu e o log ja registra "enviado". Perder a
  // evidencia do provedor nao pode virar falha de envio.
  async function recordProviderDelivery(logId, response) {
    if (!logId || typeof dispatchLogs.updateProviderDelivery !== "function") {
      return;
    }

    try {
      await dispatchLogs.updateProviderDelivery(logId, extractProviderDelivery(response));
    } catch (error) {
      logger.error &&
        logger.error(
          JSON.stringify({
            event: "mensagens.record_provider_delivery_failed",
            log_id: logId,
            error_message: error?.message,
          })
        );
    }
  }

  // Instancias disponiveis para disparo (ordenadas por prioridade) e o N global
  // de rodizio, para que buildJitteredDispatchSchedule resolva a instancia de
  // cada grupo. listDispatchable exclui numeros pausados - eles seguem
  // conectados, mas nao entram no rodizio do disparador pontual.
  async function resolveInstanceRotation() {
    const [instances, rotationSettings] = await Promise.all([
      typeof whatsappInstances.listDispatchable === "function"
        ? whatsappInstances.listDispatchable()
        : typeof whatsappInstances.listActive === "function"
          ? whatsappInstances.listActive()
          : [],
      typeof whatsappInstancesService.getRotationSettings === "function"
        ? whatsappInstancesService.getRotationSettings()
        : {},
    ]);

    return {
      whatsapp_instances: instances || [],
      rotation_group_count: rotationSettings && rotationSettings.whatsapp_rotation_group_count,
    };
  }

  async function resolveScheduleSettings() {
    try {
      return await settingsService.getScheduleSettings();
    } catch (error) {
      return {};
    }
  }

  // Usado por resumeCampaign: recria os jobs de mensagens-dispatch dos logs
  // ainda pendentes de uma campanha pontual, quando o job original nao
  // sobreviveu no Redis (ja tinha disparado-e-virado-no-op durante a pausa).
  // O texto/link ja estao fixados na campanha - nao ha "proximo conteudo" para
  // re-resolver, so reenviar o que ja estava decidido.
  // LIMITACAO CONHECIDA: campanhas com midia (possui_midia=true, vinda de
  // upload) nao tem o arquivo em campaign.link_conteudo - por exigencia de
  // nunca persistir o anexo, so a flag booleana fica salva. Se o job original
  // for perdido do Redis durante a pausa, o resume cai neste caminho e
  // reenvia so o texto, sem a midia, silenciosamente. Aceito como tradeoff:
  // e um caso raro (o job so desaparece do Redis nesse meio tempo) e
  // consistente com a exigencia de nao persistir o arquivo.
  //
  // O spool (services/media-spool.js) NAO muda isto, de proposito. Ele guarda o
  // anexo por TTL, mas quem sabe a chave e' o job - e e' justamente o job que se
  // perdeu neste cenario. Recuperar exigiria gravar a chave do anexo na
  // campanha, ou seja, um ponteiro persistente para o arquivo no banco: e'
  // exatamente a decisao que o usuario tomou em contrario, e nao se reabre sem
  // pedido explicito.
  async function requeuePendingMessages(campaign, pendingLogs) {
    if (!Array.isArray(pendingLogs) || pendingLogs.length === 0) {
      return [];
    }

    const texto = campaign.texto_mensagem || undefined;
    const content = campaign.link_conteudo
      ? {
          url: campaign.link_conteudo,
          type:
            campaign.link_conteudo_tipo === "documento"
              ? "document"
              : campaign.link_conteudo_tipo === "video"
              ? "video"
              : "image",
        }
      : undefined;
    const instanceRotation = await resolveInstanceRotation();
    const jobs = [];

    for (const [index, log] of pendingLogs.entries()) {
      try {
        // Horario original do log, nunca "agora": buildMensagensJobData usa
        // `= new Date()` como default do parametro, entao passar null aqui
        // reestampava o envio antigo como recem-agendado e ele escapava da trava
        // de atraso. Sem horario em que ancorar, o log exige acao manual.
        const logScheduledAt = resolveLogScheduledAt(log);

        if (!logScheduledAt) {
          logger.warn &&
            logger.warn(
              JSON.stringify({
                event: "mensagens.requeue_skipped_sem_horario",
                campaign_id: campaign.id,
                log_id: log.id,
                group_id: log.group_id,
              })
            );
          continue;
        }

        const group = await repository.findById(log.group_id);

        if (!group || !group.evolution_group_id) {
          continue;
        }

        const dispatchOrder = index + 1;
        const job = await enqueue(
          {
            group_id: group.evolution_group_id,
            internal_group_id: group.id,
            group_nome: group.nome,
            message: texto,
            content,
            scheduled_at: logScheduledAt,
            // Mesma janela da campanha retomada: o resume nao pode devolver o
            // envio a fila com a trava mais rigida do que ela era no
            // agendamento original.
            window_end: campaign.window_end || null,
            dispatch_order: dispatchOrder,
            dispatch_log_id: log.id,
            whatsapp_instance_id: resolveInstanceForOrder(
              dispatchOrder,
              instanceRotation.whatsapp_instances,
              instanceRotation.rotation_group_count
            ),
          },
          { removeOnComplete: false, removeOnFail: false }
        );

        jobs.push(job);

        if (typeof dispatchLogs.updateDispatchJobId === "function") {
          await dispatchLogs.updateDispatchJobId(log.id, job.id).catch(() => undefined);
        }
      } catch (error) {
        logger.error &&
          logger.error(
            JSON.stringify({
              event: "mensagens.requeue_pending_message_failed",
              campaign_id: campaign.id,
              log_id: log.id,
              error_message: error?.message,
            })
          );
      }
    }

    return jobs;
  }

  async function createAdHocCampaign({
    payload,
    texto,
    link,
    linkConteudoTipo,
    possuiMidia,
    status,
    dataEnvio,
    windowStart,
    windowEnd,
    jitterDelayMinMs,
    jitterDelayMaxMs,
    triggerFiredAt,
    hidden,
  }) {
    const scheduleSettings = await resolveScheduleSettings();
    const referenceDate = windowStart ? new Date(windowStart) : new Date();

    return campaigns.create({
      tipo: "pontual",
      ativo: true,
      status,
      // Campanha ad-hoc criada so para ancorar o log de um disparo que o usuario
      // nao pediu para persistir como campanha: fica oculta das listagens
      // (findAll/listActive filtram hidden_at), mas os logs que apontam para ela
      // seguem visiveis no relatorio - hideByDateRange e quem oculta logs.
      hidden_at: hidden ? new Date().toISOString() : null,
      trilha: formatAdHocCampaignName(referenceDate, scheduleSettings.timezone),
      titulo: normalizeTitulo(payload),
      classificacao: normalizeClassificacao(payload),
      texto_mensagem: texto || null,
      // Anexo de upload nunca vira link_conteudo (nao ha URL, so base64 em
      // memoria) - so a flag possui_midia registra que houve midia no envio.
      // link_conteudo_tipo so faz sentido acompanhando um link_conteudo real;
      // sem link (caso do upload), tipoConteudo vem preenchido ("imagem"/
      // "video") so para a Evolution, e nao deve virar coluna no BD.
      link_conteudo: link || null,
      link_conteudo_tipo: link ? linkConteudoTipo || null : null,
      possui_midia: Boolean(possuiMidia),
      data_envio: dataEnvio || formatDateOnlyInTimezone(referenceDate, scheduleSettings.timezone),
      window_start: windowStart || null,
      window_end: windowEnd || null,
      jitter_delay_min_ms: Number.isFinite(jitterDelayMinMs) ? jitterDelayMinMs : null,
      jitter_delay_max_ms: Number.isFinite(jitterDelayMaxMs) ? jitterDelayMaxMs : null,
      // Disparo pontual agendado cria todos os jobs de uma vez, aqui mesmo em
      // scheduleAdHoc - nao ha fase separada de "trigger" como na campanha de
      // video, entao ja nasce marcado para o resume saber que deve recriar/
      // reagendar os jobs de mensagens-dispatch diretamente.
      trigger_fired_at: triggerFiredAt || null,
    });
  }

  // Marca como "falhou" todo log pendente do lote quando o preparo da midia nao
  // conclui. Sem isso a compressao quebrada deixaria os logs em "pendente" para
  // sempre: getDispatchStatus nunca finalizaria e a tela ficaria girando.
  async function failPendingLogs(logIds, mensagemErro) {
    await Promise.all(
      logIds.filter(Boolean).map((logId) =>
        dispatchLogs.updateStatus(logId, "falhou", mensagemErro).catch((error) => {
          logger.error &&
            logger.error(
              JSON.stringify({
                event: "mensagens.fail_pending_log_failed",
                dispatch_log_id: logId,
                error_message: error?.message,
              })
            );
        })
      )
    );
  }

  /*
    Prepara a midia (remux/recompressao via ffmpeg) e so entao enfileira os jobs.

    Roda FORA do ciclo da requisicao HTTP de proposito. O ffmpeg leva minutos num
    video grande; se isso acontecesse antes do 202, a requisicao estouraria o
    timeout do proxy e o navegador entregaria "Failed to fetch" - exatamente o
    problema que as rotas /async existem para eliminar. A campanha e os logs
    pendentes ja foram criados pelo chamador, entao a tela tem o que acompanhar
    por getDispatchStatus desde o primeiro instante.

    LIMITACAO CONHECIDA: ate o deposito no spool, o anexo so existe na RAM deste
    processo. Se a API reiniciar DURANTE a compressao, o envio se perde e os logs
    ficam pendentes ate a trava de atraso do worker (resolveJobStaleReason)
    cancela-los. Depois do deposito a janela fecha: os bytes ja nao dependem
    deste processo.
  */
  async function prepareMediaAndEnqueue({ content, logIds, enqueueJobs, onError }) {
    let prepared = content;

    try {
      prepared = await prepareMedia(content, { logger });
    } catch (error) {
      logger.error &&
        logger.error(
          JSON.stringify({
            event: "mensagens.prepare_media_failed",
            error_message: error?.message,
          })
        );

      const mensagemErro = `Falha ao preparar a midia para envio: ${error?.message || "erro desconhecido"}`;

      await failPendingLogs(logIds, mensagemErro);

      if (typeof onError === "function") {
        await onError(error);
      }

      return;
    }

    /*
      Deposita o anexo UMA vez e passa a referencia aos jobs, em vez de copiar o
      base64 para dentro de cada um.

      Antes, cada grupo do lote levava o arquivo inteiro no seu job data - e o
      worker reescrevia esse payload completo a cada `job.updateData`, duas ou
      tres vezes por envio. Um video de 100 MB para 30 grupos escrevia da ordem
      de 9 GB no Redis (que roda com appendonly) por disparo. Ver
      services/media-spool.js para o desenho e para o que isso significa perante
      a exigencia de nao persistir o anexo.

      Falha no deposito nao e' silenciada: sem a referencia os jobs sairiam sem
      anexo, entregando ao grupo algo diferente do que foi agendado.
    */
    let mediaReference = null;

    if (prepared && typeof prepared.base64 === "string" && prepared.base64.length > 0) {
      try {
        mediaReference = await depositMedia(prepared, { consumers: logIds.length || 1 });
      } catch (error) {
        logger.error &&
          logger.error(
            JSON.stringify({
              event: "mensagens.media_spool_failed",
              error_message: error?.message,
            })
          );

        const mensagemErro = `Falha ao preparar o anexo para envio: ${error?.message || "erro desconhecido"}`;

        await failPendingLogs(logIds, mensagemErro);

        if (typeof onError === "function") {
          await onError(error);
        }

        return;
      }
    }

    try {
      await enqueueJobs(prepared, mediaReference);
    } catch (error) {
      // O enfileiramento em si falhou (Redis fora do ar, por exemplo). Sem isto
      // os logs ficariam "pendente" para sempre, do mesmo jeito que numa falha
      // de compressao - e a tela nunca fecharia o polling.
      logger.error &&
        logger.error(
          JSON.stringify({
            event: "mensagens.enqueue_after_prepare_failed",
            error_message: error?.message,
          })
        );

      await failPendingLogs(logIds, `Falha ao enfileirar o envio: ${error?.message || "erro desconhecido"}`);

      throw error;
    }
  }

  // true quando o preparo pode demorar (video que sera remuxado/recomprimido) e
  // portanto nao deve segurar a requisicao HTTP. Texto, link e imagem passam
  // direto pelo preparo, entao nao vale pagar o custo de diferir.
  function mediaNeedsBackgroundPreparation(content) {
    return Boolean(content) && content.type === "video" && typeof content.base64 === "string";
  }

  async function dispatchAdHoc(payload = {}, context = {}) {
    const groupIds = normalizeGroupIds(payload);

    if (!groupIds.length) {
      throw new Error("Selecione ao menos um grupo");
    }

    const { texto, content: originalContent, tipoConteudo } = normalizeContent(payload);
    // Preparo uma unica vez, antes do loop de grupos: sem isso o mesmo video
    // seria recomprimido a cada grupo do disparo.
    //
    // Aqui o preparo e aguardado (ao contrario de dispatchAdHocAsync e
    // scheduleAdHoc, que o jogam para segundo plano): esta rota e sincrona por
    // contrato - envia e devolve o resultado do envio na propria resposta - e a
    // tela nao a usa, so clientes de script. Quem chama por HTTP com video
    // grande deve usar /mensagens/dispatch/async, que responde 202 na hora.
    const content = await prepareMedia(originalContent, { logger });

    await assertAnyInstanceDispatchable();

    // Resolvida uma vez fora do loop so para saber qual instancia registrar no
    // log: o disparo imediato nao associa grupo a instancia (ver comentario em
    // `send`, acima), entao todo grupo desta chamada cai na mesma resolucao -
    // nao interfere no envio em si, que continua indo por `send`. Pulado
    // quando sendToEvolution ou resolveInstanceSender foram injetados
    // explicitamente (uso em teste): nesses casos o real resolveInstance
    // consultaria uma instancia diferente da que o sender injetado usa.
    const resolvedInstanceId =
      dependencies.sendToEvolution || dependencies.resolveInstanceSender
        ? null
        : (await resolveInstance(undefined, { whatsappInstancesRepository: whatsappInstances })).instance?.id || null;

    // ORDEM CRITICA: registrar antes de enviar.
    //
    // Antes, esta funcao enviava para todos os grupos e SO DEPOIS criava a
    // campanha ancora e os logs, dentro de um try/catch que apenas registrava o
    // evento. Quando o INSERT falhava, as mensagens ja estavam nos grupos e
    // nenhuma linha existia em `logs` - e a resposta HTTP ainda dizia
    // "enviados: N". Aconteceu duas vezes em producao (04/09/2026, 21:13 e
    // 21:45 UTC): a constraint de campaigns.classificacao nao aceitava
    // "capacitacao", que a tela oferece (ver migration 202609070001). Dois
    // disparos entregues e invisiveis no relatorio.
    //
    // Agora a ancora e os logs "pendente" nascem primeiro. Se essa gravacao
    // falhar, o erro sobe e NADA e enviado - o pior caso passa a ser um envio
    // que nao aconteceu, em vez de um envio que aconteceu e ninguem registrou.
    // Mesma ordem que dispatchAdHocAsync e scheduleAdHoc ja usavam.
    const groups = await resolveGroups(groupIds);
    const campaign = await createAdHocCampaign({
      payload,
      texto,
      link: content?.url,
      linkConteudoTipo: tipoConteudo,
      possuiMidia: Boolean(content),
      // "programado" enquanto os envios acontecem; vira "concluido" no fim.
      // Antes nascia "concluido" porque a campanha era criada depois de tudo.
      status: "programado",
      hidden: !payload.persist_as_campaign,
    });
    const plannedAt = new Date().toISOString();
    const entries = [];

    for (const [index, group] of groups.entries()) {
      const groupId = groupIds[index];

      // Grupo invalido continua sendo falha DAQUELE grupo (e nao da requisicao
      // inteira), como antes - mas agora com log, para nao virar envio que
      // ninguem pediu e nao aparece em lugar nenhum.
      const invalidReason = !group
        ? "Grupo nao encontrado"
        : !group.evolution_group_id
          ? "Grupo sem evolution_group_id"
          : !group.segmento
            ? "Grupo sem classificacao (segmento)"
            : null;

      if (group) {
        await campaignGroups.associateGroup(campaign.id, group.id, group.organization_id);
      }

      const log = group
        ? await dispatchLogs.createLog({
            campaign_id: campaign.id,
            group_id: group.id,
            video_id: null,
            status: invalidReason ? "falhou" : "pendente",
            mensagem_erro: invalidReason,
            horario_envio_planejado: plannedAt,
            usuario_responsavel_id: context.userId || null,
            whatsapp_instance_id: resolvedInstanceId,
          })
        : null;

      entries.push({ group, groupId, log, invalidReason });
    }

    const results = await mapWithConcurrency(
      entries,
      resolveAdHocDispatchConcurrency(),
      async ({ group, groupId, log, invalidReason }) => {
        if (invalidReason) {
          return {
            group_id: groupId,
            group_nome: group?.nome,
            organization_id: group?.organization_id,
            ok: false,
            error: invalidReason,
          };
        }

        try {
          const sendParams = { groupId: group.evolution_group_id };

          if (texto) {
            sendParams.message = texto;
          }

          if (content) {
            sendParams.content = content;
          }

          const response = await send(sendParams);
          // Mesmo criterio do envio de video: 200 com corpo de erro nao e entrega.
          assertDeliveryConfirmed(response);
          // E aceite tambem nao e entrega: espera o ACK do WhatsApp antes de
          // reportar sucesso para a tela e gravar "enviado" no log.
          response.delivery_confirmation = await confirmDelivery(response, {
            logger,
            context: { group_id: groupId, group_nome: group.nome },
          });

          await updateAdHocLogOutcome(log, "enviado", null, resolvedInstanceId);
          await recordProviderDelivery(log && log.id, response);

          return {
            group_id: groupId,
            group_nome: group.nome,
            ok: true,
            response,
            organization_id: group.organization_id,
            whatsapp_instance_id: resolvedInstanceId,
            dispatch_log_id: (log && log.id) || null,
          };
        } catch (error) {
          const mensagemErro = error?.message || "Falha ao enviar";

          await updateAdHocLogOutcome(log, "falhou", mensagemErro, resolvedInstanceId);

          return {
            group_id: groupId,
            group_nome: group?.nome,
            organization_id: group?.organization_id,
            ok: false,
            error: mensagemErro,
            dispatch_log_id: (log && log.id) || null,
          };
        }
      }
    );

    const enviados = results.filter((result) => result.ok).length;
    const falhas = results.filter((result) => !result.ok).length;

    // Fecha a campanha ancora. Best-effort de proposito: os logs (que sao a
    // fonte do relatorio) ja carregam o desfecho de cada grupo, entao falhar
    // aqui atrasa o rotulo da campanha, nao perde registro de envio.
    if (typeof campaigns.update === "function") {
      await campaigns.update(campaign.id, { status: "concluido" }).catch((error) => {
        logger.error &&
          logger.error(
            JSON.stringify({
              event: "mensagens.ad_hoc_campaign_close_failed",
              campaign_id: campaign.id,
              error_message: error?.message,
            })
          );
      });
    }

    return { campaign_id: campaign.id, enviados, falhas, results };
  }

  // Envio imediato assincrono (usado pelo botao "Enviar teste para este grupo").
  //
  // Por que existe, se dispatchAdHoc ja envia na hora: dispatchAdHoc segura a
  // conexao HTTP ate a Evolution responder (ate EVOLUTION_API_MEDIA_TIMEOUT_MS,
  // 180s com midia) e ainda espera o ACK. Com a Evolution lenta a requisicao
  // estourava o timeout de proxy/CDN e o navegador mostrava "Failed to fetch" -
  // com a mensagem, muitas vezes, ja entregue no grupo. Aqui a validacao (que e
  // rapida: so banco) continua sincrona, para o usuario ver erro de verdade em
  // vez de um "enfileirado" que falha depois; so o envio em si vai para a fila,
  // com delay 0. A tela acompanha por getDispatchStatus.
  async function dispatchAdHocAsync(payload = {}, context = {}) {
    const groupIds = normalizeGroupIds(payload);

    if (!groupIds.length) {
      throw new Error("Selecione ao menos um grupo");
    }

    const { texto, content, tipoConteudo } = normalizeContent(payload);

    const groups = await resolveGroups(groupIds);
    const missing = groups.map((group, index) => (group ? null : groupIds[index])).filter(Boolean);

    if (missing.length) {
      throw new Error(`Grupo(s) nao encontrado(s): ${missing.join(", ")}`);
    }

    const withoutEvolutionId = groups.filter((group) => !group.evolution_group_id);

    if (withoutEvolutionId.length) {
      throw new Error(`Grupo(s) sem evolution_group_id: ${withoutEvolutionId.map((group) => group.nome).join(", ")}`);
    }

    const withoutSegmento = groups.filter((group) => !group.segmento);

    if (withoutSegmento.length) {
      throw new Error(
        `Grupo(s) sem classificacao (segmento): ${withoutSegmento.map((group) => group.nome).join(", ")}`
      );
    }

    await assertAnyInstanceDispatchable();

    // Mesma resolucao do dispatchAdHoc sincrono: disparo imediato nao faz
    // rodizio por grupo, tudo vai pela primeira instancia disponivel.
    const { instance } = await resolveInstance(undefined, { whatsappInstancesRepository: whatsappInstances });
    const whatsappInstanceId = (instance && instance.id) || null;

    // Campanha ancora e logs pendentes sao criados aqui, sincronos, e nao no
    // worker: e o campaign_id devolvido no 202 que da a tela o que consultar em
    // getDispatchStatus desde o primeiro instante.
    const campaign = await createAdHocCampaign({
      payload,
      texto,
      link: content?.url,
      linkConteudoTipo: tipoConteudo,
      possuiMidia: Boolean(content),
      // "programado", igual ao scheduleAdHoc: os jobs ja estao na fila mas o
      // envio ainda nao fechou. "em_andamento" nao existe na constraint CHECK
      // de campaigns.status e o insert falharia.
      status: "programado",
      hidden: !payload.persist_as_campaign,
    });

    const scheduledAt = new Date();
    const jobs = [];

    for (const group of groups) {
      await campaignGroups.associateGroup(campaign.id, group.id, group.organization_id);

      const log = await dispatchLogs.createLog({
        campaign_id: campaign.id,
        group_id: group.id,
        video_id: null,
        status: "pendente",
        // Agora: a trava de atraso do worker (resolveJobStaleReason) compara com
        // este horario, e um job que sai imediatamente nunca fica atrasado.
        horario_envio_planejado: scheduledAt.toISOString(),
        usuario_responsavel_id: context.userId || null,
        whatsapp_instance_id: whatsappInstanceId,
      });

      jobs.push({
        group_id: group.id,
        group_nome: group.nome,
        dispatch_log_id: (log && log.id) || null,
        job_id: null,
      });
    }

    async function enqueueJobs(preparedContent, mediaReference) {
      // O horario planejado e reescrito depois do preparo: a trava de atraso do
      // worker (resolveJobStaleReason) compara o job com este horario, e uma
      // compressao de varios minutos faria um job recem-criado ja nascer
      // "atrasado" e ser cancelado sem enviar.
      const dispatchAt = new Date();

      for (let index = 0; index < groups.length; index += 1) {
        const group = groups[index];
        const entry = jobs[index];

        if (entry.dispatch_log_id && typeof dispatchLogs.updatePlannedSchedule === "function") {
          await dispatchLogs
            .updatePlannedSchedule(entry.dispatch_log_id, dispatchAt.toISOString())
            .catch(() => undefined);
        }

        const job = await enqueue(
          {
            group_id: group.evolution_group_id,
            internal_group_id: group.id,
            group_nome: group.nome,
            message: texto || "",
            // Anexo pelo spool (uma copia por lote) em vez do base64 dentro de
            // cada job - ver services/media-spool.js.
            content: mediaReference ? null : preparedContent || null,
            content_ref: mediaReference,
            scheduled_at: dispatchAt,
            dispatch_log_id: entry.dispatch_log_id,
            whatsapp_instance_id: whatsappInstanceId,
          },
          // delay 0 explicito: sem jitter, sem janela - o teste tem que sair na
          // hora. buildMensagensJobOptions ja calcularia 0 com scheduled_at=agora,
          // mas explicitar impede que uma mudanca naquele calculo insira atraso
          // aqui sem querer.
          { delay: 0 }
        );

        entry.job_id = (job && job.id) || null;
      }
    }

    const logIds = jobs.map((entry) => entry.dispatch_log_id);

    // Video: o preparo (ffmpeg) pode levar minutos, entao ele e o enfileiramento
    // saem do ciclo da requisicao. A resposta 202 vai agora, com o campaign_id
    // que a tela usa no polling; os jobs entram na fila quando a compressao
    // terminar. Sem midia pesada, enfileira inline como antes.
    if (mediaNeedsBackgroundPreparation(content)) {
      prepareMediaAndEnqueue({ content, logIds, enqueueJobs }).catch((error) => {
        logger.error &&
          logger.error(
            JSON.stringify({
              event: "mensagens.background_dispatch_failed",
              campaign_id: campaign.id,
              error_message: error?.message,
            })
          );
      });

      return { campaign_id: campaign.id, enfileirados: jobs.length, jobs, preparando_midia: true };
    }

    await prepareMediaAndEnqueue({ content, logIds, enqueueJobs });

    return { campaign_id: campaign.id, enfileirados: jobs.length, jobs };
  }

  // Consultado em polling pela tela logo apos o 202 de dispatchAdHocAsync. Le o
  // estado dos logs (mesma fonte do relatorio operacional), nao o estado dos
  // jobs na BullMQ: o log e quem sobrevive a um restart do worker.
  async function getDispatchStatus(campaignId) {
    if (!campaignId) {
      throw new Error("campaign_id e obrigatorio");
    }

    const logs = (await dispatchLogs.listByCampaign(campaignId)) || [];
    // listByCampaign faz select("*") - sem join de grupo -, entao o nome vem do
    // repositorio de grupos, em uma consulta por grupo distinto do lote.
    const nomePorGrupo = new Map();

    await Promise.all(
      [...new Set(logs.map((log) => log.group_id).filter(Boolean))].map(async (groupId) => {
        const group = await repository.findById(groupId).catch(() => null);
        nomePorGrupo.set(groupId, (group && group.nome) || null);
      })
    );

    const results = logs.map((log) => ({
      group_id: log.group_id,
      group_nome: nomePorGrupo.get(log.group_id) || null,
      status: log.status,
      ok: log.status === "enviado",
      error: log.mensagem_erro || null,
    }));
    // "pendente"/"processando" e o unico estado em que ainda vale perguntar de
    // novo; qualquer outro (enviado, falhou, cancelado) e definitivo.
    const pendentes = results.filter((result) => result.status === "pendente" || result.status === "processando");

    return {
      campaign_id: campaignId,
      finalizado: pendentes.length === 0,
      enviados: results.filter((result) => result.status === "enviado").length,
      falhas: results.filter((result) => result.status === "falhou").length,
      pendentes: pendentes.length,
      results,
    };
  }

  async function scheduleAdHoc(payload = {}, context = {}) {
    const groupIds = normalizeGroupIds(payload);

    if (!groupIds.length) {
      throw new Error("Selecione ao menos um grupo");
    }

    const { texto, content, tipoConteudo } = normalizeContent(payload);

    if (!payload.window_start || !payload.window_end) {
      throw new Error("window_start e window_end sao obrigatorios para agendar com intervalo");
    }

    const windowStartDate = new Date(payload.window_start);

    if (Number.isNaN(windowStartDate.getTime())) {
      throw new Error("window_start deve ser uma data valida");
    }

    if (windowStartDate.getTime() <= Date.now()) {
      throw new Error("window_start deve ser uma data/hora futura");
    }

    const groups = await resolveGroups(groupIds);
    const missing = groups
      .map((group, index) => (group ? null : groupIds[index]))
      .filter(Boolean);

    if (missing.length) {
      throw new Error(`Grupo(s) nao encontrado(s): ${missing.join(", ")}`);
    }

    const withoutEvolutionId = groups.filter((group) => !group.evolution_group_id);

    if (withoutEvolutionId.length) {
      throw new Error(
        `Grupo(s) sem evolution_group_id: ${withoutEvolutionId.map((group) => group.nome).join(", ")}`
      );
    }

    const withoutSegmento = groups.filter((group) => !group.segmento);

    if (withoutSegmento.length) {
      throw new Error(
        `Grupo(s) sem classificacao (segmento): ${withoutSegmento.map((group) => group.nome).join(", ")}`
      );
    }

    await assertAnyInstanceDispatchable();
    await assertInstanceCoverage(groups);

    const scheduleSettings = await resolveScheduleSettings();
    const jitterDelayMinMs = Number.isFinite(Number(payload.jitter_delay_min_ms))
      ? Number(payload.jitter_delay_min_ms)
      : Number.isInteger(scheduleSettings.min_interval_min)
      ? scheduleSettings.min_interval_min * 60000
      : undefined;
    const jitterDelayMaxMs = Number.isFinite(Number(payload.jitter_delay_max_ms))
      ? Number(payload.jitter_delay_max_ms)
      : Number.isInteger(scheduleSettings.max_interval_min)
      ? scheduleSettings.max_interval_min * 60000
      : undefined;

    // Um pontual agendado por cima da janela de outro pontual nos mesmos
    // grupos e o mesmo conflito que o caminho de video ja bloqueia entre
    // videos: os dois resolveriam o "proximo" daquele grupo na mesma fila
    // (mensagens-dispatch) e um atropelaria o outro. Pontual x campanha de
    // video nos mesmos grupos/janela e permitido - sao filas independentes
    // (mensagens-dispatch x dispatch), cada uma resolve seu proprio "proximo".
    await assertNoCampaignWindowConflict({
      campaignsRepository: campaigns,
      campaignGroupsRepository: campaignGroups,
      groupIds: groups.map((group) => group.id),
      windowStart: payload.window_start,
      windowEnd: payload.window_end,
      timezone: payload.timezone || scheduleSettings.timezone,
      campaignType: "pontual",
    });

    const instanceRotation = await resolveInstanceRotation();

    const schedule = buildSchedule({
      groups: groups.map((group, index) => ({ group_id: group.id, order: index + 1 })),
      window_start: payload.window_start,
      window_end: payload.window_end,
      jitter_delay_min_ms: jitterDelayMinMs,
      jitter_delay_max_ms: jitterDelayMaxMs,
      ...instanceRotation,
    });

    let campaign = null;

    // Sempre cria a campanha ancora: e ela que da campaign_id aos logs pendentes
    // criados logo abaixo, e sem log pendente o envio agendado chega ao grupo sem
    // nunca aparecer no relatorio. persist_as_campaign controla so a visibilidade
    // da campanha na UI (hidden_at), nao a existencia do registro.
    {
      try {
        campaign = await createAdHocCampaign({
          payload,
          texto,
          link: content?.url,
          linkConteudoTipo: tipoConteudo,
          possuiMidia: Boolean(content),
          status: "programado",
          windowStart: payload.window_start,
          windowEnd: payload.window_end,
          jitterDelayMinMs,
          jitterDelayMaxMs,
          triggerFiredAt: new Date().toISOString(),
          hidden: !payload.persist_as_campaign,
        });

        await Promise.all(
          groups.map((group) => campaignGroups.associateGroup(campaign.id, group.id, group.organization_id))
        );
      } catch (error) {
        campaign = null;
        logger.error &&
          logger.error(
            JSON.stringify({
              event: "mensagens.persist_ad_hoc_campaign_failed",
              error_message: error?.message,
            })
          );
      }
    }

    const scheduled = [];

    // Logs pendentes primeiro, sincronos: e o que o relatorio operacional e o
    // getDispatchStatus leem. So o enfileiramento (que espera o preparo da
    // midia) sai do ciclo da requisicao.
    for (let index = 0; index < schedule.length; index += 1) {
      const item = schedule[index];
      const group = groups[index];

      let dispatchLogId;

      if (campaign) {
        try {
          const log = await dispatchLogs.createLog({
            campaign_id: campaign.id,
            group_id: group.id,
            video_id: null,
            status: "pendente",
            horario_envio_planejado: item.scheduled_at,
            usuario_responsavel_id: context.userId || null,
            // O rodizio ja resolveu o numero aqui; gravar de imediato faz a
            // coluna "Numero" do relatorio sair correta ja no log pendente, em
            // vez de so quando o worker fecha o envio.
            whatsapp_instance_id: item.whatsapp_instance_id || null,
          });
          dispatchLogId = log.id;
        } catch (error) {
          logger.error &&
            logger.error(
              JSON.stringify({
                event: "mensagens.create_dispatch_log_failed",
                campaign_id: campaign.id,
                group_id: group.id,
                error_message: error?.message,
              })
            );
        }
      }

      scheduled.push({
        group_id: group.id,
        group_nome: group.nome,
        scheduled_at: item.scheduled_at,
        dispatch_log_id: dispatchLogId || null,
        job_id: null,
      });
    }

    // `mediaReference` aponta para o anexo depositado uma unica vez no spool; o
    // base64 nao entra no job data. Quando nao ha anexo (texto, ou link por URL,
    // que o worker resolve sozinho) a referencia e' nula e `content` segue como
    // antes.
    async function enqueueJobs(preparedContent, mediaReference) {
      for (let index = 0; index < schedule.length; index += 1) {
        const item = schedule[index];
        const group = groups[index];
        const entry = scheduled[index];

        const job = await enqueue(
          {
            group_id: group.evolution_group_id,
            internal_group_id: group.id,
            group_nome: group.nome,
            message: texto,
            content: mediaReference ? null : preparedContent,
            content_ref: mediaReference,
            // Nao re-estampado (ao contrario do disparo imediato): estes sao
            // horarios futuros escolhidos pelo usuario na janela, e a compressao
            // termina muito antes deles.
            scheduled_at: item.scheduled_at,
            // Ate o fim da janela o envio continua sendo o que o usuario pediu,
            // mesmo se a fila atrasar - ver a regra de janela em
            // dispatch-staleness.js.
            window_end: payload.window_end,
            dispatch_order: item.dispatch_order,
            jitter_delay_ms: item.jitter_delay_ms,
            cumulative_delay_ms: item.cumulative_delay_ms,
            dispatch_log_id: entry.dispatch_log_id,
            whatsapp_instance_id: item.whatsapp_instance_id,
          },
          { removeOnComplete: false, removeOnFail: false }
        );

        // Grava o id do job no log para o resume conseguir localiza-lo direto
        // (queue.getJob(id)) em vez de escanear a fila - best-effort, perder isso
        // so degrada o resume para o caminho de recriar o job do zero.
        if (entry.dispatch_log_id && typeof dispatchLogs.updateDispatchJobId === "function") {
          await dispatchLogs.updateDispatchJobId(entry.dispatch_log_id, job.id).catch(() => undefined);
        }

        entry.job_id = (job && job.id) || null;
      }
    }

    const logIds = scheduled.map((entry) => entry.dispatch_log_id);

    // Mesmo motivo do disparo imediato: com video, o ffmpeg pode levar minutos e
    // nao pode segurar a resposta. O agendamento ja esta gravado nos logs, entao
    // a tela mostra o disparo programado na hora e os jobs entram na fila assim
    // que a compressao terminar - bem antes da janela de envio.
    if (mediaNeedsBackgroundPreparation(content)) {
      prepareMediaAndEnqueue({ content, logIds, enqueueJobs }).catch((error) => {
        logger.error &&
          logger.error(
            JSON.stringify({
              event: "mensagens.background_schedule_failed",
              campaign_id: campaign && campaign.id,
              error_message: error?.message,
            })
          );
      });

      return { scheduled: scheduled.length, jobs: scheduled, preparando_midia: true };
    }

    await prepareMediaAndEnqueue({ content, logIds, enqueueJobs });

    return { scheduled: scheduled.length, jobs: scheduled };
  }

  return { dispatchAdHoc, dispatchAdHocAsync, getDispatchStatus, scheduleAdHoc, requeuePendingMessages };
}

module.exports = createMensagensService();
module.exports.createMensagensService = createMensagensService;
// Exportado para que tests/mensagens-classificacao-schema-contract.test.js
// possa travar esta lista contra a constraint CHECK de campaigns.classificacao
// e contra as opcoes da tela. As tres divergiram em producao ("capacitacao"
// existia aqui e na tela, nao no banco) e o efeito foi envio entregue sem
// nenhuma linha em `logs` - ver a migration 202609070001.
module.exports.CLASSIFICACOES = CLASSIFICACOES;
