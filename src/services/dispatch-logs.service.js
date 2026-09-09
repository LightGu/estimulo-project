const dispatchLogsRepository = require("../repositories/dispatch-logs.repository");
const campaignsRepository = require("../repositories/campaigns.repository");
const groupsRepository = require("../repositories/groups.repository");
const videoCatalogRepository = require("../repositories/video-catalog.repository");

function assertValidReportDateRange(startDate, endDate) {
  const today = new Date().toISOString().slice(0, 10);

  if (!startDate) {
    throw new Error("Start date is required");
  }

  if (!endDate) {
    throw new Error("End date is required");
  }

  if (startDate > today) {
    throw new Error("Start date cannot be in the future");
  }

  if (endDate > today) {
    throw new Error("End date cannot be in the future");
  }

  if (startDate > endDate) {
    throw new Error("Start date cannot be after end date");
  }
}

// Fallback do resumo quando o repositorio nao sabe contar por status (mocks de
// teste). Conta o que esta em maos - correto quando o array e' o conjunto todo.
function buildSummaryFromRows(rows = []) {
  const counts = { pendente: 0, processando: 0, enviado: 0, erro: 0, falhou: 0, cancelado: 0 };

  for (const row of rows) {
    if (counts[row.status] !== undefined) {
      counts[row.status] += 1;
    }
  }

  return counts;
}

function createDispatchLogsService(dependencies = {}) {
  const repository = dependencies.repository || dispatchLogsRepository;
  const campaignsRepositoryDependency = dependencies.campaignsRepository || campaignsRepository;
  const groupsRepositoryDependency = dependencies.groupsRepository || groupsRepository;
  const videoCatalogRepositoryDependency = dependencies.videoCatalogRepository || videoCatalogRepository;

  async function createLog(payload) {
    const campaignId = payload?.campaign_id;
    const groupId = payload?.group_id;
    const videoId = payload?.video_id;
    const status = payload?.status || "pendente";

    if (!campaignId) {
      throw new Error("Campaign id is required");
    }

    if (!groupId) {
      throw new Error("Group id is required");
    }

    const campaign = await campaignsRepositoryDependency.findById(campaignId);
    const group = await groupsRepositoryDependency.findById(groupId);

    if (!campaign) {
      throw new Error("Campaign not found");
    }

    if (!group) {
      throw new Error("Group not found");
    }

    if (videoId) {
      const video = await videoCatalogRepositoryDependency.findById(videoId);

      if (!video) {
        throw new Error("Video not found");
      }
    }

    const validStatuses = ["pendente", "processando", "enviado", "falhou"];

    if (!validStatuses.includes(status)) {
      throw new Error("Invalid status");
    }

    return repository.createLog({ ...payload, status });
  }

  async function updateStatus(id, status, mensagemErro = null, whatsappInstanceId) {
    if (!id) {
      throw new Error("Dispatch log id is required");
    }

    const validStatuses = ["pendente", "processando", "enviado", "falhou"];

    if (!validStatuses.includes(status)) {
      throw new Error("Invalid status");
    }

    return repository.updateStatus(id, status, mensagemErro, whatsappInstanceId);
  }

  async function updatePlannedSchedule(id, horarioEnvioPlanejado) {
    if (!id) {
      throw new Error("Dispatch log id is required");
    }

    if (!horarioEnvioPlanejado) {
      throw new Error("Planned dispatch time is required");
    }

    return repository.updatePlannedSchedule(id, horarioEnvioPlanejado);
  }

  async function updateInstance(id, whatsappInstanceId) {
    if (!id) {
      throw new Error("Dispatch log id is required");
    }

    return repository.updateInstance(id, whatsappInstanceId || null);
  }

  async function listByCampaign(campaignId) {
    if (!campaignId) {
      throw new Error("Campaign id is required");
    }

    return repository.listByCampaign(campaignId);
  }

  async function listByGroup(groupId) {
    if (!groupId) {
      throw new Error("Group id is required");
    }

    return repository.listByGroup(groupId);
  }

  async function listRecent(limit = 10) {
    return repository.listRecent(limit);
  }

  /*
    Uma pagina do relatorio, mais o resumo do filtro inteiro.

    Antes devolvia um array com TODAS as linhas do periodo (cinco tabelas
    embutidas, sem limite) e o filtro por organizacao era aplicado aqui, em
    memoria, depois do fetch - o custo completo pago para descartar a maior
    parte. A tela recortava com slice() e chamava isso de paginacao.

    O resumo vem separado de proposito: os cartoes contam o conjunto INTEIRO do
    filtro, nao a pagina exibida. Sem uma contagem propria, paginar faria os
    cartoes passarem a refletir apenas 100 linhas - trocar um problema de
    desempenho por um numero errado na tela nao e conserto.

    O retorno e um objeto, e o formato antigo (array puro) fica disponivel para
    quem ainda dependa dele via `data`. A tela foi atualizada junto.
  */
  async function listForReport(filters = {}) {
    const { startDate, endDate, organizationId, groupId, status, limit, offset } = filters;
    const today = new Date().toISOString().slice(0, 10);

    if (startDate && startDate > today) {
      throw new Error("Start date cannot be in the future");
    }

    if (endDate && endDate > today) {
      throw new Error("End date cannot be in the future");
    }

    if (startDate && endDate && startDate > endDate) {
      throw new Error("Start date cannot be after end date");
    }

    const repositoryFilters = {
      startDate: startDate ? `${startDate}T00:00:00.000Z` : null,
      endDate: endDate ? `${endDate}T23:59:59.999Z` : null,
      groupId: groupId || null,
      status: status || null,
      organizationId: organizationId || null,
      limit,
      offset,
    };

    const page = await repository.listWithFilters(repositoryFilters);

    // Compatibilidade com repositorios injetados em teste que ainda devolvem um
    // array puro.
    if (Array.isArray(page)) {
      const rows = organizationId
        ? page.filter((log) => log.groups?.organization_id === organizationId)
        : page;

      return {
        data: rows,
        pagination: { total: rows.length, limit: rows.length, offset: 0, has_more: false },
        summary: buildSummaryFromRows(rows),
      };
    }

    const summary =
      typeof repository.countByStatusWithFilters === "function"
        ? await repository.countByStatusWithFilters(repositoryFilters)
        : buildSummaryFromRows(page.rows);

    return {
      data: page.rows,
      pagination: {
        total: page.total,
        limit: page.limit,
        offset: page.offset,
        has_more: page.offset + page.rows.length < page.total,
      },
      summary,
    };
  }

  // "Apagar registros do relatorio por periodo": nunca remove do banco, so
  // marca hidden_at (logs.criado_em dentro de [startDate, endDate], inclusive)
  // - listForReport/listWithFilters ja passam a ignorar essas linhas. Quando
  // uma campanha fica sem nenhum log visivel restante, ela e ocultada junto
  // (findAll/listActive tambem ja filtram hidden_at), preservando a linha em
  // ambas as tabelas para auditoria.
  async function hideByDateRange(startDate, endDate) {
    assertValidReportDateRange(startDate, endDate);

    const hiddenLogs = await repository.hideByDateRange(`${startDate}T00:00:00.000Z`, `${endDate}T23:59:59.999Z`);

    const affectedCampaignIds = [...new Set(hiddenLogs.map((log) => log.campaign_id).filter(Boolean))];

    if (!affectedCampaignIds.length) {
      return { hidden_logs_count: 0, hidden_campaigns_count: 0 };
    }

    const visibleCounts = await repository.countVisibleByCampaignIds(affectedCampaignIds);
    const emptyCampaignIds = affectedCampaignIds.filter((campaignId) => !visibleCounts[campaignId]);
    const hiddenCampaigns = await campaignsRepositoryDependency.hideByIds(emptyCampaignIds);

    return {
      hidden_logs_count: hiddenLogs.length,
      hidden_campaigns_count: hiddenCampaigns.length,
    };
  }

  return {
    createLog,
    hideByDateRange,
    listByCampaign,
    listByGroup,
    listForReport,
    listRecent,
    updateInstance,
    updatePlannedSchedule,
    updateStatus,
  };
}

module.exports = createDispatchLogsService();
module.exports.createDispatchLogsService = createDispatchLogsService;
