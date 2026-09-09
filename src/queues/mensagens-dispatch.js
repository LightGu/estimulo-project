const { createQueue, createQueueEvents, createWorker } = require("./bullmq");
const { queueNames } = require("./names");
const { buildJitteredDispatchSchedule } = require("./dispatch-jitter");
const { resolveInstanceSender } = require("../services/evolution-instance-sender");
const {
  assertDeliveryConfirmed,
  confirmProviderDelivery,
  extractProviderDelivery,
} = require("../services/delivery-confirmation");
const { resolveJobStaleReason } = require("../services/dispatch-staleness");
const { buildMensagensRef } = require("../utils/dispatch-ref");
const { readMediaFromSpool, releaseMediaFromSpool } = require("../services/media-spool");
const dispatchLogsRepository = require("../repositories/dispatch-logs.repository");
const defaultCampaignsRepository = require("../repositories/campaigns.repository");

const MENSAGENS_DISPATCH_JOB_NAME = "mensagens-dispatch";
const MENSAGENS_DISPATCH_INITIAL_STATUS = "pending";
const MENSAGENS_DISPATCH_PROCESSING_STATUS = "processing";
const MENSAGENS_DISPATCH_SUCCESS_STATUS = "sent";
const MENSAGENS_DISPATCH_FAILED_STATUS = "failed";
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

// Teto do tamanho do job serializado. Generoso de proposito: o anexo em base64
// legitimamente ocupa dezenas de MB e o objetivo aqui e' barrar o absurdo (ou um
// bug de montagem de payload), nao o uso normal.
const DEFAULT_MENSAGENS_JOB_SIZE_LIMIT_BYTES = 200 * 1024 * 1024;

function resolveMensagensJobSizeLimitBytes() {
  const configured = Number(process.env.MENSAGENS_DISPATCH_JOB_SIZE_LIMIT_BYTES);

  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_MENSAGENS_JOB_SIZE_LIMIT_BYTES;
  }

  return Math.trunc(configured);
}

// Identidade logica de um envio pontual, usada como `jobId`.
//
// A BullMQ recusa em silencio um add() com jobId ja existente - e e' essa recusa
// que protege contra envio duplicado. O caminho de video ganhou
// buildDispatchJobId por esse motivo; esta fila ficou sem equivalente, com id
// sequencial gerado pela BullMQ. Consequencia: qualquer enfileiramento repetido
// do mesmo envio (resume que nao achou o job original, reprocesso de
// prepareMediaAndEnqueue, dois cliques) criava um segundo job para o MESMO
// dispatch_log_id. O claimForSend cobre o caso comum, mas o ramo legado sem
// dispatch_log_id (buildMensagensJobData aceita null) ficava sem protecao alguma.
//
// A chave preferida e' o dispatch_log_id: ele identifica o envio daquele grupo
// naquela campanha, e e' exatamente o que o worker usa para reivindicar. Sem
// ele, cai para grupo + horario, que e' o melhor disponivel.
//
// O saneamento de ":" e obrigatorio: a BullMQ so aceita ":" num jobId customizado
// se o resultado tiver EXATAMENTE 3 segmentos (formato reservado de repeatable
// jobs - ver Job.validateOptions). O horario ISO sempre tem ":" e o JID do grupo
// pode ter, entao todo componente e' normalizado antes de juntar.
function buildMensagensJobId(jobData = {}) {
  const sanitize = (value) => String(value).replace(/:/g, "_");

  if (jobData.dispatch_log_id) {
    return `mensagens|log|${sanitize(jobData.dispatch_log_id)}`;
  }

  return [
    "mensagens",
    sanitize(jobData.internal_group_id || jobData.group_id),
    sanitize(jobData.scheduled_at),
  ].join("|");
}

function getMensagensDispatchQueue() {
  if (!mensagensDispatchQueueInstance) {
    mensagensDispatchQueueInstance = createQueue(queueNames.mensagensDispatch, {
      defaultJobOptions: {
        attempts: 1,
        // `timeout` NAO existe mais nas opcoes de job da BullMQ (removido na v2;
        // aqui roda a 5.x) - ficava aqui sendo ignorado em silencio, sugerindo
        // uma garantia inexistente. Quem de fato limita a duracao e o
        // `lockDuration` do worker, configurado com o mesmo valor mais abaixo.
        //
        // `sizeLimit`, ao contrario, e' real e vale a pena: o job desta fila
        // carrega a midia em base64 dentro de `content`, ou seja, o payload
        // inteiro vai para o Redis. Sem teto, um anexo grande multiplicado pelo
        // numero de grupos escrevia gigabytes no AOF. Aqui o enfileiramento
        // falha cedo, com erro claro, em vez de degradar o Redis.
        sizeLimit: resolveMensagensJobSizeLimitBytes(),
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

  if (!params.message && !params.content && !params.content_ref && !params.contentRef) {
    throw new Error("message ou content e obrigatorio para enfileirar mensagens-dispatch");
  }

  const scheduledDate = normalizeScheduledDate(params.scheduled_at || params.scheduledAt);

  return {
    group_id: params.group_id,
    internal_group_id: params.internal_group_id || params.internalGroupId,
    group_nome: params.group_nome || params.groupNome,
    message: params.message || "",
    content: params.content || null,
    /*
      Referencia ao anexo depositado em services/media-spool.js, em vez do
      base64 dentro do job.

      Antes o anexo inteiro ia em `content`, o que o replicava por grupo (um job
      cada) e, pior, era reescrito a cada `job.updateData({ ...job.data })` do
      worker - duas ou tres vezes por envio, sempre o payload completo. Um video
      de 100 MB para 30 grupos escrevia da ordem de 9 GB no Redis, que roda com
      appendonly, num unico disparo.

      `content` continua sendo aceito e tratado pelo worker: jobs enfileirados
      antes deste deploy ainda carregam o base64 e precisam sair normalmente.
    */
    content_ref: params.content_ref || params.contentRef || null,
    scheduled_at: scheduledDate.toISOString(),
    // Fim da janela escolhida pelo usuario, propagado ate o worker: e' o que
    // permite a trava de atraso distinguir "job zumbi de dias atras" de "envio
    // desta janela que a fila atrasou" (ver dispatch-staleness.js). Nulo em
    // disparo imediato/teste, que nao tem janela - la o teto de atraso vale
    // sozinho, como antes.
    window_end: params.window_end || params.windowEnd || null,
    status: params.status || MENSAGENS_DISPATCH_INITIAL_STATUS,
    dispatch_order: params.dispatch_order,
    jitter_delay_ms: params.jitter_delay_ms,
    cumulative_delay_ms: params.cumulative_delay_ms,
    dispatch_log_id: params.dispatch_log_id || null,
    // Sem este campo o job perdia a instancia sorteada no agendamento e o worker
    // enviava tudo pelo numero do .env, independente do rodizio configurado.
    whatsapp_instance_id: params.whatsapp_instance_id || params.whatsappInstanceId || null,
    // Correlacao do envio, no mesmo formato do caminho de video (prefixo "m:"
    // para dizer de qual fila veio). Ver src/utils/dispatch-ref.js.
    dispatch_ref:
      params.dispatch_ref ||
      buildMensagensRef({
        dispatchLogId: params.dispatch_log_id,
        internalGroupId: params.internal_group_id || params.internalGroupId,
        groupId: params.group_id,
        scheduledAt: scheduledDate.toISOString(),
      }),
  };
}

function buildMensagensJobOptions(jobData, options = {}) {
  const scheduledTime = new Date(jobData.scheduled_at).getTime();
  const delay = Math.max(scheduledTime - Date.now(), 0);

  return {
    jobId: buildMensagensJobId(jobData),
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
    readSpooledMedia = readMediaFromSpool,
    releaseSpooledMedia = releaseMediaFromSpool,
    now = () => new Date(),
  } = options;

  // Best-effort em qualquer desfecho: o job nao vai mais ler o anexo, e nao
  // liberar e' recuperavel pelo TTL do spool. Um erro aqui nunca pode derrubar
  // um envio que ja aconteceu.
  async function releaseMediaReference(jobData, logger_) {
    if (!jobData.content_ref) {
      return;
    }

    try {
      await releaseSpooledMedia(jobData.content_ref);
    } catch (error) {
      logger_.warn &&
        logger_.warn(
          JSON.stringify({
            event: "mensagens_dispatch.media_release_failed",
            dispatch_ref: jobData.dispatch_ref,
            spool_key: jobData.content_ref.spool_key,
            error_message: error && error.message,
          })
        );
    }
  }

  async function updateDispatchLogStatus(dispatchLogId, status, mensagemErro, whatsappInstanceId) {
    if (!dispatchLogId) {
      return;
    }

    try {
      await dispatchLogs.updateStatus(dispatchLogId, status, mensagemErro || null, whatsappInstanceId);
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

  return async function mensagensDispatchWorker(job) {
    const startedAt = new Date().toISOString();

    // Trava de atraso: um job que so roda muito depois do horario planejado
    // (fila parada, worker que caiu e voltou, resume de campanha pausada ha
    // muito tempo) nao pode disparar por cima do horario perdido - cancela em
    // vez de mandar uma mensagem "atrasada" sem contexto para o grupo.
    //
    // Falha fechado (resolveJobStaleReason, nao resolveStaleDispatchReason):
    // todo job desta fila nasce com scheduled_at preenchido, entao job sem
    // horario aqui e job corrompido/legado - e a resposta segura para "nao sei
    // quando isto deveria sair" e nao enviar.
    const staleReason = resolveJobStaleReason(job.data.scheduled_at, {
      now,
      windowEnd: job.data.window_end,
    });

    if (staleReason) {
      const cancelled = job.data.dispatch_log_id && typeof dispatchLogs.cancelIfPending === "function"
        ? await dispatchLogs.cancelIfPending(job.data.dispatch_log_id, staleReason).catch(() => null)
        : null;

      // Sem dispatch_log_id (caminho legado) ou sem cancelIfPending disponivel: cai
      // no update incondicional para nao deixar o envio atrasado escapar sem log.
      if (!cancelled) {
        await updateDispatchLogStatus(job.data.dispatch_log_id, "cancelado", staleReason);
      }

      await job.updateData({
        ...job.data,
        status: "cancelado",
        cancelled_at: new Date().toISOString(),
        cancel_reason: staleReason,
      });

      logger.warn &&
        logger.warn(
          JSON.stringify({
            event: "mensagens_dispatch.cancelled_stale",
            job_id: job.id,
            dispatch_ref: job.data.dispatch_ref,
            group_id: job.data.group_id,
            internal_group_id: job.data.internal_group_id,
            dispatch_log_id: job.data.dispatch_log_id,
            scheduled_at: job.data.scheduled_at,
            reason: staleReason,
          })
        );

      await releaseMediaReference(job.data, logger);

      return { status: "cancelado", reason: staleReason };
    }

    // Campanha pausada: o log continua pendente (para o resume conseguir
    // retomar), entao so o claim atomico mais abaixo nao bastaria para impedir
    // o envio - esta checagem antecipada e o que de fato para.
    if (job.data.dispatch_log_id && typeof dispatchLogs.findById === "function") {
      // Estas duas consultas terminavam em `.catch(() => null)`. Como o proprio
      // comentario acima diz que esta e' a checagem "que de fato para" o envio,
      // falhar aberto aqui significava: erro transitorio no Supabase => mensagem
      // de campanha pausada/cancelada sai para o grupo, em silencio. E o claim
      // atomico mais abaixo nao salva, justamente porque numa pausa o log
      // continua "pendente" de proposito.
      //
      // Relancar faz o job falhar em vez de enviar - recuperavel pelo sweep de
      // retry, ao contrario de uma mensagem ja entregue.
      let pausedLog = null;
      let pausedCampaign = null;

      try {
        pausedLog = await dispatchLogs.findById(job.data.dispatch_log_id);

        if (pausedLog && pausedLog.campaign_id) {
          pausedCampaign = await campaignsRepository.findById(pausedLog.campaign_id);
        }
      } catch (error) {
        logger.error &&
          logger.error(
            JSON.stringify({
              event: "mensagens_dispatch.pause_check_failed",
              job_id: job.id,
              dispatch_ref: job.data.dispatch_ref,
              dispatch_log_id: job.data.dispatch_log_id,
              error_message: error && error.message,
            })
          );

        throw new Error(
          `Nao foi possivel verificar se a campanha esta pausada antes do envio: ${error && error.message}`
        );
      }

      if (pausedCampaign && (pausedCampaign.status === "pausado" || pausedCampaign.status === "cancelado")) {
        // Este job nao vai mais ler o anexo. Um resume cria job NOVO, que
        // passa por requeuePendingMessages e nao tem referencia de anexo
        // (limitacao ja conhecida e documentada la), entao liberar aqui nao
        // tira midia de ninguem - so evita esperar o TTL.
        await releaseMediaReference(job.data, logger);

        return { status: pausedCampaign.status === "cancelado" ? "skipped_cancelled" : "skipped_paused" };
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
                dispatch_ref: job.data.dispatch_ref,
                dispatch_log_id: job.data.dispatch_log_id,
              })
            );

          await releaseMediaReference(job.data, logger);

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
            dispatch_ref: job.data.dispatch_ref,
            group_id: job.data.group_id,
            internal_group_id: job.data.internal_group_id,
            scheduled_at: job.data.scheduled_at,
          })
        );

      const sendParams = { groupId: job.data.group_id };

      if (job.data.message) {
        sendParams.message = job.data.message;
      }

      // `content` inline: jobs enfileirados antes da introducao do spool, que
      // ainda carregam o base64 no payload. Precisam continuar saindo.
      if (job.data.content) {
        sendParams.content = job.data.content;
      } else if (job.data.content_ref) {
        // Lido aqui, no ultimo instante antes do envio, e nao no inicio do job:
        // e' o que mantem o base64 fora da memoria durante a checagem de pausa,
        // o claim e a espera na fila.
        const spooled = await readSpooledMedia(job.data.content_ref);

        if (!spooled) {
          // Anexo sumiu do spool (TTL vencido com o job atrasado, ou Redis
          // limpo). Falhar e' obrigatorio: enviar so o texto entregaria ao grupo
          // uma mensagem diferente da que foi agendada, e sem aviso.
          throw new Error(
            `Anexo do envio nao esta mais disponivel para envio (${
              job.data.content_ref.file_name || "arquivo"
            }): o agendamento expirou antes de ser processado`
          );
        }

        sendParams.content = spooled;
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
          dispatch_ref: job.data.dispatch_ref,
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

      await updateDispatchLogStatus(job.data.dispatch_log_id, "enviado", null, job.data.whatsapp_instance_id || null);
      await recordProviderDelivery(job.data.dispatch_log_id, result);
      // Depois de gravar o log: o anexo ja foi entregue, e perder a liberacao e'
      // recuperavel pelo TTL, enquanto perder o registro do envio nao e'.
      await releaseMediaReference(job.data, logger);

      logger.info &&
        logger.info(
          JSON.stringify({
            event: "mensagens_dispatch.sent",
            job_id: job.id,
            dispatch_ref: job.data.dispatch_ref,
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

      await updateDispatchLogStatus(job.data.dispatch_log_id, "falhou", error.message, job.data.whatsapp_instance_id || null);
      // attempts: 1 nesta fila - a falha e' final, o anexo nao sera lido de novo.
      await releaseMediaReference(job.data, logger);

      logger.error &&
        logger.error(
          JSON.stringify({
            event: "mensagens_dispatch.failed",
            job_id: job.id,
            dispatch_ref: job.data.dispatch_ref,
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
  MENSAGENS_DISPATCH_PROCESSING_STATUS,
  MENSAGENS_DISPATCH_SUCCESS_STATUS,
  addJitteredMensagensDispatchJobs,
  addMensagensDispatchJob,
  buildMensagensJobData,
  buildMensagensJobId,
  createMensagensDispatchEvents,
  createMensagensDispatchProcessor,
  createMensagensDispatchWorker,
  mensagensDispatchWorker,
  get mensagensDispatchQueue() {
    return getMensagensDispatchQueue();
  },
};
