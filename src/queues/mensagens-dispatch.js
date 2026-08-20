const { createQueue, createQueueEvents, createWorker } = require("./bullmq");
const { queueNames } = require("./names");
const { buildJitteredDispatchSchedule } = require("./dispatch-jitter");
const { resolveInstanceSender } = require("../services/evolution-instance-sender");
const {
  assertDeliveryConfirmed,
  confirmProviderDelivery,
  extractProviderDelivery,
} = require("../services/delivery-confirmation");
const {
  DEFAULT_MAX_POSTPONEMENTS,
  resolveAdHocDispatchBlock,
} = require("../services/dispatch-exclusivity");
const dispatchLogsRepository = require("../repositories/dispatch-logs.repository");
const defaultCampaignsRepository = require("../repositories/campaigns.repository");

const MENSAGENS_DISPATCH_JOB_NAME = "mensagens-dispatch";
const MENSAGENS_DISPATCH_INITIAL_STATUS = "pending";
const MENSAGENS_DISPATCH_PROCESSING_STATUS = "processing";
const MENSAGENS_DISPATCH_SUCCESS_STATUS = "sent";
const MENSAGENS_DISPATCH_FAILED_STATUS = "failed";
const MENSAGENS_DISPATCH_POSTPONED_STATUS = "postponed";
// Antes eram 60s, dimensionados para "postar e esquecer". Agora o job tambem
// espera o ACK do WhatsApp (ate DELIVERY_CONFIRMATION_TIMEOUT_MS, 90s por
// padrao), entao o teto precisa cobrir envio + confirmacao.
const DEFAULT_MENSAGENS_DISPATCH_JOB_TIMEOUT_MS = 5 * 60 * 1000;

let mensagensDispatchQueueInstance;

function resolveMensagensDispatchJobTimeoutMs() {
  const timeoutMs = Number(process.env.MENSAGENS_DISPATCH_JOB_TIMEOUT_MS || DEFAULT_MENSAGENS_DISPATCH_JOB_TIMEOUT_MS);

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_MENSAGENS_DISPATCH_JOB_TIMEOUT_MS;
  }

  return Math.trunc(timeoutMs);
}

function getMensagensDispatchQueue() {
  if (!mensagensDispatchQueueInstance) {
    mensagensDispatchQueueInstance = createQueue(queueNames.mensagensDispatch, {
      defaultJobOptions: {
        attempts: 1,
        timeout: resolveMensagensDispatchJobTimeoutMs(),
      },
    });
  }

  return mensagensDispatchQueueInstance;
}

function normalizeScheduledDate(scheduledAt = new Date()) {
  const date = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);

  if (Number.isNaN(date.getTime())) {
    throw new Error("scheduled_at deve ser uma data valida");
  }

  return date;
}

function assertRequiredField(params, fieldName) {
  if (!params || params[fieldName] === undefined || params[fieldName] === null || params[fieldName] === "") {
    throw new Error(`${fieldName} e obrigatorio para enfileirar mensagens-dispatch`);
  }
}

function buildMensagensJobData(params = {}) {
  assertRequiredField(params, "group_id");

  if (!params.message && !params.content) {
    throw new Error("message ou content e obrigatorio para enfileirar mensagens-dispatch");
  }

  const scheduledDate = normalizeScheduledDate(params.scheduled_at || params.scheduledAt);

  return {
    group_id: params.group_id,
    internal_group_id: params.internal_group_id || params.internalGroupId,
    group_nome: params.group_nome || params.groupNome,
    message: params.message || "",
    content: params.content || null,
    scheduled_at: scheduledDate.toISOString(),
    status: params.status || MENSAGENS_DISPATCH_INITIAL_STATUS,
    dispatch_order: params.dispatch_order,
    jitter_delay_ms: params.jitter_delay_ms,
    cumulative_delay_ms: params.cumulative_delay_ms,
    dispatch_log_id: params.dispatch_log_id || null,
    // Sem este campo o job perdia a instancia sorteada no agendamento e o worker
    // enviava tudo pelo numero do .env, independente do rodizio configurado.
    whatsapp_instance_id: params.whatsapp_instance_id || params.whatsappInstanceId || null,
    // Quantas vezes este envio ja foi adiado por campanha de video em voo.
    // Viaja no job para o teto de adiamentos valer entre reenfileiramentos.
    postponed_count: Number(params.postponed_count || params.postponedCount || 0),
  };
}

function buildMensagensJobOptions(jobData, options = {}) {
  const scheduledTime = new Date(jobData.scheduled_at).getTime();
  const delay = Math.max(scheduledTime - Date.now(), 0);

  return {
    ...options,
    delay: options.delay ?? delay,
  };
}

async function addMensagensDispatchJob(params, options = {}) {
  const jobData = buildMensagensJobData(params);
  const jobOptions = buildMensagensJobOptions(jobData, options);

  return getMensagensDispatchQueue().add(MENSAGENS_DISPATCH_JOB_NAME, jobData, jobOptions);
}

async function addJitteredMensagensDispatchJobs(params, options = {}) {
  const schedule = buildJitteredDispatchSchedule(params);
  const jobs = [];

  for (const jobData of schedule) {
    jobs.push(await addMensagensDispatchJob(jobData, options));
  }

  return jobs;
}

function createMensagensDispatchProcessor(options = {}) {
  const {
    sender: explicitSender,
    logger = console,
    dispatchLogs = dispatchLogsRepository,
    whatsappInstancesRepository,
    campaignsRepository = defaultCampaignsRepository,
    confirmDelivery = confirmProviderDelivery,
    enqueue = addMensagensDispatchJob,
    maxPostponements = DEFAULT_MAX_POSTPONEMENTS,
    now = () => new Date(),
  } = options;

  async function updateDispatchLogStatus(dispatchLogId, status, mensagemErro) {
    if (!dispatchLogId) {
      return;
    }

    try {
      await dispatchLogs.updateStatus(dispatchLogId, status, mensagemErro || null);
    } catch (error) {
      logger.error &&
        logger.error(
          JSON.stringify({
            event: "mensagens_dispatch.update_log_failed",
            dispatch_log_id: dispatchLogId,
            status,
            error_message: error?.message,
          })
        );
    }
  }

  // Best-effort, igual ao caminho de video: a mensagem ja saiu, perder a
  // evidencia nao pode derrubar o job.
  async function recordProviderDelivery(dispatchLogId, result) {
    if (!dispatchLogId || typeof dispatchLogs.updateProviderDelivery !== "function") {
      return;
    }

    try {
      await dispatchLogs.updateProviderDelivery(dispatchLogId, extractProviderDelivery(result));
    } catch (error) {
      logger.error &&
        logger.error(
          JSON.stringify({
            event: "mensagens_dispatch.record_provider_delivery_failed",
            dispatch_log_id: dispatchLogId,
            error_message: error?.message,
          })
        );
    }
  }

  // Reagenda o job para depois da campanha de video em vez de disparar por cima
  // dela. O log volta para "pendente" com o novo horario planejado, entao o
  // relatorio mostra o adiamento em vez de uma linha parada em "processando".
  async function postponeForVideoCampaign(job, block) {
    const postponedCount = Number(job.data.postponed_count || 0) + 1;
    const resumeAt = block.resumeAt.toISOString();

    if (postponedCount > maxPostponements) {
      throw new Error(
        `Envio adiado ${maxPostponements} vezes por ${block.reason} e nao chegou a sair. ` +
          "Reagende a mensagem para um horario fora da janela das campanhas de video."
      );
    }

    await enqueue(
      { ...job.data, scheduled_at: resumeAt, postponed_count: postponedCount },
      { removeOnComplete: false, removeOnFail: false }
    );

    if (job.data.dispatch_log_id && typeof dispatchLogs.updatePlannedSchedule === "function") {
      try {
        await dispatchLogs.updatePlannedSchedule(job.data.dispatch_log_id, resumeAt);
      } catch (error) {
        logger.error &&
          logger.error(
            JSON.stringify({
              event: "mensagens_dispatch.update_planned_schedule_failed",
              dispatch_log_id: job.data.dispatch_log_id,
              error_message: error?.message,
            })
          );
      }
    }

    await updateDispatchLogStatus(job.data.dispatch_log_id, "pendente");

    logger.warn &&
      logger.warn(
        JSON.stringify({
          event: "mensagens_dispatch.postponed",
          job_id: job.id,
          group_id: job.data.group_id,
          internal_group_id: job.data.internal_group_id,
          reason: block.reason,
          campaign_id: block.campaign && block.campaign.id,
          resume_at: resumeAt,
          postponed_count: postponedCount,
        })
      );

    return {
      status: MENSAGENS_DISPATCH_POSTPONED_STATUS,
      reason: block.reason,
      resume_at: resumeAt,
      postponed_count: postponedCount,
    };
  }

  return async function mensagensDispatchWorker(job) {
    const startedAt = new Date().toISOString();

    // Campanha pausada: o log continua pendente (para o resume conseguir
    // retomar), entao so o claim atomico mais abaixo nao bastaria para impedir
    // o envio - esta checagem antecipada e o que de fato para.
    if (job.data.dispatch_log_id && typeof dispatchLogs.findById === "function") {
      const pausedLog = await dispatchLogs.findById(job.data.dispatch_log_id).catch(() => null);
      const pausedCampaign =
        pausedLog && pausedLog.campaign_id
          ? await campaignsRepository.findById(pausedLog.campaign_id).catch(() => null)
          : null;

      if (pausedCampaign && pausedCampaign.status === "pausado") {
        return { status: "skipped_paused" };
      }
    }

    // Antes de qualquer coisa: mensagem pontual nao divide a sessao do WhatsApp
    // com campanha de video. A checagem e refeita aqui (e nao apenas no
    // agendamento) porque a campanha pode ter sido criada depois, ou ter
    // estourado a janela original.
    const block = await resolveAdHocDispatchBlock({ campaignsRepository, at: now() }).catch((error) => {
      // Falha ao consultar campanhas nao pode virar mensagem nao enviada: segue
      // o fluxo normal e registra.
      logger.error &&
        logger.error(
          JSON.stringify({
            event: "mensagens_dispatch.exclusivity_check_failed",
            job_id: job.id,
            error_message: error?.message,
          })
        );

      return null;
    });

    if (block) {
      try {
        return await postponeForVideoCampaign(job, block);
      } catch (error) {
        const failedAt = new Date().toISOString();

        await job.updateData({
          ...job.data,
          status: MENSAGENS_DISPATCH_FAILED_STATUS,
          failed_at: failedAt,
          error_message: error.message,
        });
        await updateDispatchLogStatus(job.data.dispatch_log_id, "falhou", error.message);

        logger.error &&
          logger.error(
            JSON.stringify({
              event: "mensagens_dispatch.postpone_failed",
              job_id: job.id,
              group_id: job.data.group_id,
              internal_group_id: job.data.internal_group_id,
              failed_at: failedAt,
              error_message: error.message,
            })
          );

        throw error;
      }
    }

    await job.updateData({
      ...job.data,
      status: MENSAGENS_DISPATCH_PROCESSING_STATUS,
      started_at: startedAt,
    });

    // Reivindicacao atomica (so avanca se o log ainda estiver pendente): fecha
    // a corrida entre um job antigo que sobreviveu a uma pausa e o job novo
    // criado no resume para o mesmo log, e tambem cobre cancelamento (o log ja
    // virou "cancelado" antes deste ponto, entao o claim falha e nao envia).
    // Ja grava "processando" como parte do UPDATE condicional - substitui o
    // updateDispatchLogStatus incondicional que existia aqui antes.
    if (job.data.dispatch_log_id) {
      if (typeof dispatchLogs.claimForSend === "function") {
        const claimedLog = await dispatchLogs.claimForSend(job.data.dispatch_log_id);

        if (!claimedLog) {
          logger.warn &&
            logger.warn(
              JSON.stringify({
                event: "mensagens_dispatch.claim_lost",
                job_id: job.id,
                dispatch_log_id: job.data.dispatch_log_id,
              })
            );

          return { status: "skipped" };
        }
      } else {
        await updateDispatchLogStatus(job.data.dispatch_log_id, "processando");
      }
    }

    try {
      logger.info &&
        logger.info(
          JSON.stringify({
            event: "mensagens_dispatch.started",
            job_id: job.id,
            group_id: job.data.group_id,
            internal_group_id: job.data.internal_group_id,
            scheduled_at: job.data.scheduled_at,
          })
        );

      const sendParams = { groupId: job.data.group_id };

      if (job.data.message) {
        sendParams.message = job.data.message;
      }

      if (job.data.content) {
        sendParams.content = job.data.content;
      }

      // Resolvido por job (e nao uma vez no processor) porque cada grupo da
      // janela pode ter caido em uma instancia diferente do rodizio.
      const sender =
        explicitSender || (await resolveInstanceSender(job.data.whatsapp_instance_id, { whatsappInstancesRepository }));
      const result = await sender(sendParams);
      // A Evolution responde 200 mesmo em recusa: sem esta checagem o log virava
      // "enviado" e o relatorio mostrava entrega que nao ocorreu.
      assertDeliveryConfirmed(result);
      // E aceite tambem nao e entrega: so vira "enviado" depois que o WhatsApp
      // confirma o ACK da mensagem.
      result.delivery_confirmation = await confirmDelivery(result, {
        logger,
        context: {
          job_id: job.id,
          group_id: job.data.group_id,
          internal_group_id: job.data.internal_group_id,
        },
      });
      const completedAt = new Date().toISOString();

      await job.updateData({
        ...job.data,
        status: MENSAGENS_DISPATCH_SUCCESS_STATUS,
        started_at: startedAt,
        completed_at: completedAt,
      });

      await updateDispatchLogStatus(job.data.dispatch_log_id, "enviado");
      await recordProviderDelivery(job.data.dispatch_log_id, result);

      logger.info &&
        logger.info(
          JSON.stringify({
            event: "mensagens_dispatch.sent",
            job_id: job.id,
            group_id: job.data.group_id,
            internal_group_id: job.data.internal_group_id,
            started_at: startedAt,
            completed_at: completedAt,
          })
        );

      return {
        status: MENSAGENS_DISPATCH_SUCCESS_STATUS,
        delivery: result,
        started_at: startedAt,
        completed_at: completedAt,
      };
    } catch (error) {
      const failedAt = new Date().toISOString();

      await job.updateData({
        ...job.data,
        status: MENSAGENS_DISPATCH_FAILED_STATUS,
        started_at: startedAt,
        failed_at: failedAt,
        error_message: error.message,
      });

      await updateDispatchLogStatus(job.data.dispatch_log_id, "falhou", error.message);

      logger.error &&
        logger.error(
          JSON.stringify({
            event: "mensagens_dispatch.failed",
            job_id: job.id,
            group_id: job.data.group_id,
            internal_group_id: job.data.internal_group_id,
            started_at: startedAt,
            failed_at: failedAt,
            error_message: error.message,
          })
        );

      throw error;
    }
  };
}

const mensagensDispatchWorker = createMensagensDispatchProcessor();

function createMensagensDispatchWorker(options = {}) {
  const {
    sender,
    logger = console,
    dispatchLogs = dispatchLogsRepository,
    whatsappInstancesRepository,
    campaignsRepository,
    maxPostponements,
    ...workerOptions
  } = options;

  return createWorker(
    queueNames.mensagensDispatch,
    createMensagensDispatchProcessor({
      sender,
      logger,
      dispatchLogs,
      whatsappInstancesRepository,
      campaignsRepository,
      maxPostponements,
    }),
    {
      // O job agora espera o ACK do WhatsApp; sem esticar o lock a BullMQ
      // consideraria o job travado e o reentregaria no meio da confirmacao.
      lockDuration: resolveMensagensDispatchJobTimeoutMs(),
      ...workerOptions,
    }
  );
}

function createMensagensDispatchEvents(options = {}) {
  return createQueueEvents(queueNames.mensagensDispatch, options);
}

module.exports = {
  MENSAGENS_DISPATCH_FAILED_STATUS,
  MENSAGENS_DISPATCH_INITIAL_STATUS,
  MENSAGENS_DISPATCH_JOB_NAME,
  MENSAGENS_DISPATCH_POSTPONED_STATUS,
  MENSAGENS_DISPATCH_PROCESSING_STATUS,
  MENSAGENS_DISPATCH_SUCCESS_STATUS,
  addJitteredMensagensDispatchJobs,
  addMensagensDispatchJob,
  buildMensagensJobData,
  createMensagensDispatchEvents,
  createMensagensDispatchProcessor,
  createMensagensDispatchWorker,
  mensagensDispatchWorker,
  get mensagensDispatchQueue() {
    return getMensagensDispatchQueue();
  },
};
