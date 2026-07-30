const groupsRepository = require("../repositories/groups.repository");
const campaignsRepository = require("../repositories/campaigns.repository");
const campaignGroupsRepository = require("../repositories/campaign-groups.repository");
const dispatchLogsRepository = require("../repositories/dispatch-logs.repository");
const { sendToEvolution } = require("./evolution");
const { buildJitteredDispatchSchedule } = require("../queues/dispatch-jitter");
const { addMensagensDispatchJob } = require("../queues/mensagens-dispatch");
const defaultSettingsService = require("./settings.service");
const { formatAdHocCampaignName, formatDateOnlyInTimezone } = require("../utils/campaign-naming");

const CLASSIFICACOES = ["evento", "credito", "pesquisa", "aviso", "outro"];

function normalizeGroupIds(payload = {}) {
  return Array.isArray(payload.group_ids) ? [...new Set(payload.group_ids.filter(Boolean))] : [];
}

function normalizeContent(payload = {}) {
  const texto = typeof payload.texto === "string" ? payload.texto.trim() : "";
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

  return { texto, content };
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
  const send = dependencies.sendToEvolution || sendToEvolution;
  const buildSchedule = dependencies.buildJitteredDispatchSchedule || buildJitteredDispatchSchedule;
  const enqueue = dependencies.addMensagensDispatchJob || addMensagensDispatchJob;
  const settingsService = dependencies.settingsService || defaultSettingsService;
  const logger = dependencies.logger || console;

  async function resolveGroups(groupIds) {
    return Promise.all(groupIds.map((groupId) => repository.findById(groupId)));
  }

  async function resolveScheduleSettings() {
    try {
      return await settingsService.getScheduleSettings();
    } catch (error) {
      return {};
    }
  }

  async function createAdHocCampaign({ payload, texto, link, status, dataEnvio, windowStart, windowEnd, jitterDelayMinMs, jitterDelayMaxMs }) {
    const scheduleSettings = await resolveScheduleSettings();
    const referenceDate = windowStart ? new Date(windowStart) : new Date();

    return campaigns.create({
      tipo: "pontual",
      ativo: true,
      status,
      trilha: formatAdHocCampaignName(referenceDate, scheduleSettings.timezone),
      titulo: normalizeTitulo(payload),
      classificacao: normalizeClassificacao(payload),
      texto_mensagem: texto || null,
      link_conteudo: link || null,
      data_envio: dataEnvio || formatDateOnlyInTimezone(referenceDate, scheduleSettings.timezone),
      window_start: windowStart || null,
      window_end: windowEnd || null,
      jitter_delay_min_ms: Number.isFinite(jitterDelayMinMs) ? jitterDelayMinMs : null,
      jitter_delay_max_ms: Number.isFinite(jitterDelayMaxMs) ? jitterDelayMaxMs : null,
    });
  }

  async function dispatchAdHoc(payload = {}) {
    const groupIds = normalizeGroupIds(payload);

    if (!groupIds.length) {
      throw new Error("Selecione ao menos um grupo");
    }

    const { texto, content } = normalizeContent(payload);

    const results = await Promise.all(
      groupIds.map(async (groupId) => {
        try {
          const group = await repository.findById(groupId);

          if (!group) {
            return { group_id: groupId, ok: false, error: "Grupo nao encontrado" };
          }

          if (!group.evolution_group_id) {
            return { group_id: groupId, group_nome: group.nome, ok: false, error: "Grupo sem evolution_group_id" };
          }

          if (!group.segmento) {
            return { group_id: groupId, group_nome: group.nome, ok: false, error: "Grupo sem classificacao (segmento)" };
          }

          const sendParams = { groupId: group.evolution_group_id };

          if (texto) {
            sendParams.message = texto;
          }

          if (content) {
            sendParams.content = content;
          }

          const response = await send(sendParams);

          return { group_id: groupId, group_nome: group.nome, ok: true, response, organization_id: group.organization_id };
        } catch (error) {
          const group = await repository.findById(groupId).catch(() => null);
          return {
            group_id: groupId,
            group_nome: group?.nome,
            organization_id: group?.organization_id,
            ok: false,
            error: error?.message || "Falha ao enviar",
          };
        }
      })
    );

    const enviados = results.filter((result) => result.ok).length;
    const falhas = results.filter((result) => !result.ok).length;

    if (payload.persist_as_campaign) {
      try {
        const campaign = await createAdHocCampaign({
          payload,
          texto,
          link: content?.url,
          status: "concluido",
        });

        await Promise.all(
          results.map(async (result) => {
            if (!result.group_id) {
              return;
            }

            await campaignGroups.associateGroup(campaign.id, result.group_id, result.organization_id);
            await dispatchLogs.createLog({
              campaign_id: campaign.id,
              group_id: result.group_id,
              video_id: null,
              status: result.ok ? "enviado" : "falhou",
              mensagem_erro: result.ok ? null : result.error,
            });
          })
        );
      } catch (error) {
        logger.error &&
          logger.error(
            JSON.stringify({
              event: "mensagens.persist_ad_hoc_campaign_failed",
              error_message: error?.message,
            })
          );
      }
    }

    return { enviados, falhas, results };
  }

  async function scheduleAdHoc(payload = {}) {
    const groupIds = normalizeGroupIds(payload);

    if (!groupIds.length) {
      throw new Error("Selecione ao menos um grupo");
    }

    const { texto, content } = normalizeContent(payload);

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

    const schedule = buildSchedule({
      groups: groups.map((group, index) => ({ group_id: group.id, order: index + 1 })),
      window_start: payload.window_start,
      window_end: payload.window_end,
      jitter_delay_min_ms: jitterDelayMinMs,
      jitter_delay_max_ms: jitterDelayMaxMs,
    });

    let campaign = null;

    if (payload.persist_as_campaign) {
      try {
        campaign = await createAdHocCampaign({
          payload,
          texto,
          link: content?.url,
          status: "programado",
          windowStart: payload.window_start,
          windowEnd: payload.window_end,
          jitterDelayMinMs,
          jitterDelayMaxMs,
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

      const job = await enqueue(
        {
          group_id: group.evolution_group_id,
          internal_group_id: group.id,
          group_nome: group.nome,
          message: texto,
          content,
          scheduled_at: item.scheduled_at,
          dispatch_order: item.dispatch_order,
          jitter_delay_ms: item.jitter_delay_ms,
          cumulative_delay_ms: item.cumulative_delay_ms,
          dispatch_log_id: dispatchLogId,
        },
        { removeOnComplete: false, removeOnFail: false }
      );

      scheduled.push({
        group_id: group.id,
        group_nome: group.nome,
        scheduled_at: item.scheduled_at,
        job_id: job.id,
      });
    }

    return { scheduled: scheduled.length, jobs: scheduled };
  }

  return { dispatchAdHoc, scheduleAdHoc };
}

module.exports = createMensagensService();
module.exports.createMensagensService = createMensagensService;
