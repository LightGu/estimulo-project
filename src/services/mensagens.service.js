const groupsRepository = require("../repositories/groups.repository");
const { sendToEvolution } = require("./evolution");
const { buildJitteredDispatchSchedule } = require("../queues/dispatch-jitter");
const { addMensagensDispatchJob } = require("../queues/mensagens-dispatch");

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

function createMensagensService(dependencies = {}) {
  const repository = dependencies.groupsRepository || groupsRepository;
  const send = dependencies.sendToEvolution || sendToEvolution;
  const buildSchedule = dependencies.buildJitteredDispatchSchedule || buildJitteredDispatchSchedule;
  const enqueue = dependencies.addMensagensDispatchJob || addMensagensDispatchJob;

  async function resolveGroups(groupIds) {
    return Promise.all(groupIds.map((groupId) => repository.findById(groupId)));
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

          const sendParams = { groupId: group.evolution_group_id };

          if (texto) {
            sendParams.message = texto;
          }

          if (content) {
            sendParams.content = content;
          }

          const response = await send(sendParams);

          return { group_id: groupId, group_nome: group.nome, ok: true, response };
        } catch (error) {
          return { group_id: groupId, ok: false, error: error?.message || "Falha ao enviar" };
        }
      })
    );

    return {
      enviados: results.filter((result) => result.ok).length,
      falhas: results.filter((result) => !result.ok).length,
      results,
    };
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

    const schedule = buildSchedule({
      groups: groups.map((group, index) => ({ group_id: group.id, order: index + 1 })),
      window_start: payload.window_start,
      window_end: payload.window_end,
      jitter_delay_min_ms: payload.jitter_delay_min_ms,
      jitter_delay_max_ms: payload.jitter_delay_max_ms,
    });

    const scheduled = [];

    for (let index = 0; index < schedule.length; index += 1) {
      const item = schedule[index];
      const group = groups[index];

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
