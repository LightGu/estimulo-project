const groupsRepository = require("../repositories/groups.repository");
const organizationsRepository = require("../repositories/organizations.repository");
const groupProfilesRepository = require("../repositories/group-profiles.repository");
const trilhasRepository = require("../repositories/trilhas.repository");
const videoCatalogRepository = require("../repositories/video-catalog.repository");
const whatsappInstancesRepository = require("../repositories/whatsapp-instances.repository");
const groupWhatsappInstancesRepository = require("../repositories/group-whatsapp-instances.repository");
const { addDispatchJob } = require("../queues/dispatch");
const { fetchAllGroupsFromEvolution } = require("./evolution");
const { evolutionConfig } = require("../config/evolution");
const whatsappInstancesService = require("./whatsapp-instances.service");
const defaultTrilhaSequenceService = require("./trilha-sequence.service");

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function countParticipants(group) {
  const participants = firstDefined(group?.participants, group?.Participants, group?.participantsIds, group?.participantIds);

  if (Array.isArray(participants)) {
    return participants.length;
  }

  const count = firstDefined(
    group?.participantsCount,
    group?.participantCount,
    group?.membersCount,
    group?.memberCount,
    group?.size,
    group?._count?.participants,
  );
  const numberCount = Number(count);

  return Number.isFinite(numberCount) && numberCount >= 0 ? numberCount : 0;
}

function extractEvolutionGroups(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  if (Array.isArray(payload?.groups)) {
    return payload.groups;
  }

  if (Array.isArray(payload?.response)) {
    return payload.response;
  }

  return [];
}

function normalizeEvolutionGroup(group) {
  const id = String(firstDefined(group?.id, group?.jid, group?.JID, group?.remoteJid, group?.groupJid) || "").trim();
  const nome = String(firstDefined(group?.subject, group?.name, group?.Name, group?.nome) || "").trim();

  if (!id || !nome) {
    return null;
  }

  return {
    id,
    nome,
    quantidade_membros: countParticipants(group),
  };
}

function matchesNameFilter(group, filter) {
  const normalizedFilter = String(filter || "").trim().toLowerCase();

  if (!normalizedFilter) {
    return true;
  }

  return String(group?.nome || "").toLowerCase().includes(normalizedFilter);
}

function normalizeNullableText(value, fieldName) {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string or null`);
  }

  const normalized = value.trim();

  return normalized || null;
}

function createGroupsService(dependencies = {}) {
  const repository = dependencies.repository || groupsRepository;
  const organizationRepository = dependencies.organizationRepository || organizationsRepository;
  const groupProfilesRepositoryDependency = dependencies.groupProfilesRepository || groupProfilesRepository;
  const trilhasRepositoryDependency = dependencies.trilhasRepository || trilhasRepository;
  const instancesRepository = dependencies.whatsappInstancesRepository || whatsappInstancesRepository;
  const groupInstancesRepository = dependencies.groupWhatsappInstancesRepository || groupWhatsappInstancesRepository;
  const instancesService = dependencies.whatsappInstancesService || whatsappInstancesService;
  const fetchEvolutionGroups = dependencies.fetchEvolutionGroups || fetchAllGroupsFromEvolution;
  const enqueueDispatch = dependencies.addDispatchJob || addDispatchJob;
  const videoCatalogRepositoryDependency = dependencies.videoCatalogRepository || videoCatalogRepository;
  const trilhaSequenceServiceDependency = dependencies.trilhaSequenceService || defaultTrilhaSequenceService;

  async function create(payload) {
    const nome = payload?.nome?.trim();
    const organizationId = payload?.organization_id;
    const evolutionGroupId = payload?.evolution_group_id?.trim();
    const maturidade = Number(payload?.maturidade);

    if (!nome) {
      throw new Error("Group name is required");
    }

    if (!organizationId) {
      throw new Error("Organization id is required");
    }

    if (!evolutionGroupId) {
      throw new Error("Evolution group id is required");
    }

    if (!Number.isInteger(maturidade) || maturidade < 1 || maturidade > 4) {
      throw new Error("Maturidade must be between 1 and 4");
    }

    const organization = await organizationRepository.findById(organizationId);

    if (!organization) {
      throw new Error("Organization not found");
    }

    const existingGroups = await repository.findAll();
    const duplicate = existingGroups.some((item) => item.evolution_group_id?.toLowerCase() === evolutionGroupId.toLowerCase());

    if (duplicate) {
      throw new Error("Group already exists");
    }

    return repository.create({ ...payload, nome, evolution_group_id: evolutionGroupId });
  }

  async function update(id, payload) {
    if (!id) {
      throw new Error("Group id is required");
    }

    if (!payload || Object.keys(payload).length === 0) {
      throw new Error("At least one field is required");
    }

    const current = await repository.findById(id);

    if (!current) {
      throw new Error("Group not found");
    }

    const nextPayload = { ...payload };

    if (nextPayload.nome !== undefined) {
      nextPayload.nome = nextPayload.nome.trim();

      if (!nextPayload.nome) {
        throw new Error("Group name is required");
      }
    }

    if (nextPayload.organization_id !== undefined && !nextPayload.organization_id) {
      throw new Error("Organization id is required");
    }

    if (nextPayload.evolution_group_id !== undefined) {
      nextPayload.evolution_group_id = nextPayload.evolution_group_id.trim();

      if (!nextPayload.evolution_group_id) {
        throw new Error("Evolution group id is required");
      }
    }

    if (nextPayload.maturidade !== undefined) {
      nextPayload.maturidade = Number(nextPayload.maturidade);

      if (!Number.isInteger(nextPayload.maturidade) || nextPayload.maturidade < 1 || nextPayload.maturidade > 4) {
        throw new Error("Maturidade must be between 1 and 4");
      }
    }

    return repository.update(id, nextPayload);
  }

  async function updateOperationalSettings(id, payload = {}) {
    if (!id) {
      throw new Error("Group id is required");
    }

    const allowedFields = ["organization_id", "profile_id", "segmento", "setor", "envia_video", "trilha_override", "trilha_id"];
    const hasAllowedField = allowedFields.some((field) => Object.prototype.hasOwnProperty.call(payload, field));

    if (!hasAllowedField) {
      throw new Error("At least one operational setting is required");
    }

    const current = await repository.findById(id);

    if (!current) {
      throw new Error("Group not found");
    }

    const nextPayload = {};

    if (Object.prototype.hasOwnProperty.call(payload, "segmento")) {
      nextPayload.segmento = normalizeNullableText(payload.segmento, "Segmento");
    }

    // profile_id e a identidade canonica do perfil do grupo (FK para group_profiles).
    // Um trigger de banco (trg_sync_groups_segmento_text) espelha group_profiles.nome
    // em groups.segmento sempre que profile_id muda, entao nao precisamos setar
    // segmento manualmente aqui - so validar que o perfil existe.
    if (Object.prototype.hasOwnProperty.call(payload, "profile_id")) {
      const profileId = normalizeNullableText(payload.profile_id, "Profile id");

      if (profileId) {
        const profiles = await groupProfilesRepositoryDependency.findAll();
        const profile = profiles.find((item) => item.id === profileId);

        if (!profile) {
          throw new Error("Profile not found");
        }
      }

      nextPayload.profile_id = profileId;
    }

    if (Object.prototype.hasOwnProperty.call(payload, "setor")) {
      nextPayload.setor = normalizeNullableText(payload.setor, "Setor");
    }

    if (Object.prototype.hasOwnProperty.call(payload, "organization_id")) {
      const organizationId = normalizeNullableText(payload.organization_id, "Organization id");

      if (organizationId) {
        const organization = await organizationRepository.findById(organizationId);

        if (!organization) {
          throw new Error("Organization not found");
        }
      }

      nextPayload.organization_id = organizationId;
    }

    if (Object.prototype.hasOwnProperty.call(payload, "trilha_override")) {
      nextPayload.trilha_override = normalizeNullableText(payload.trilha_override, "Trilha override");
    }

    if (Object.prototype.hasOwnProperty.call(payload, "trilha_id")) {
      const trilhaId = normalizeNullableText(payload.trilha_id, "Trilha id");

      if (trilhaId) {
        const trilha = await trilhasRepositoryDependency.findById(trilhaId);

        if (!trilha) {
          throw new Error("Trilha not found");
        }
      }

      nextPayload.trilha_id = trilhaId;
    }

    if (Object.prototype.hasOwnProperty.call(payload, "envia_video")) {
      if (typeof payload.envia_video !== "boolean") {
        throw new Error("Envia video must be boolean");
      }

      nextPayload.envia_video = payload.envia_video;
    }

    return repository.update(id, nextPayload);
  }

  async function remove(id) {
    if (!id) {
      throw new Error("Group id is required");
    }

    const current = await repository.findById(id);

    if (!current) {
      throw new Error("Group not found");
    }

    return repository.delete(id);
  }

  async function getById(id) {
    if (!id) {
      throw new Error("Group id is required");
    }

    return repository.findById(id);
  }

  async function list() {
    return repository.findAll();
  }

  async function listByOrganization(organizationId) {
    if (!organizationId) {
      throw new Error("Organization id is required");
    }

    return repository.listByOrganization(organizationId);
  }

  async function listVideoEnabled() {
    return repository.listVideoEnabled();
  }

  async function listWithoutSegment(options = {}) {
    return repository.listWithoutSegment(options);
  }

  async function attachInstanceIds(groups) {
    const groupIds = groups.map((group) => group.id);
    const linksByGroup = await groupInstancesRepository.listInstanceIdsByGroupIds(groupIds);

    return groups.map((group) => ({
      ...group,
      whatsapp_instance_ids: [...(linksByGroup.get(group.id) || [])],
    }));
  }

  async function search(options = {}) {
    const whatsappInstanceId = options.whatsapp_instance_id || options.whatsappInstanceId;
    const groups = await repository.searchByName(options);

    if (!whatsappInstanceId || whatsappInstanceId === "todos") {
      return attachInstanceIds(groups);
    }

    const groupIdsForInstance = new Set(
      await groupInstancesRepository.listGroupIdsForInstance(whatsappInstanceId)
    );
    const filtered = groups.filter((group) => groupIdsForInstance.has(group.id));

    return attachInstanceIds(filtered);
  }

  async function listByInstance(whatsappInstanceId) {
    if (!whatsappInstanceId) {
      throw new Error("whatsapp_instance_id is required");
    }

    const groupIds = new Set(await groupInstancesRepository.listGroupIdsForInstance(whatsappInstanceId));
    const groups = await repository.findAll();

    return attachInstanceIds(groups.filter((group) => groupIds.has(group.id)));
  }

  async function syncGroupsFromEvolution(options = {}) {
    const organizationId = options.organization_id || options.organizationId || null;
    const maturidade = Number(options.maturidade || options.defaultMaturidade || 1);
    const nameContains = options.name_contains || options.nameContains || options.filter_name || options.filterName;
    const getParticipants =
      options.get_participants !== undefined
        ? options.get_participants
        : options.getParticipants !== undefined
          ? options.getParticipants
          : true;
    const timeoutMs = Number(
      options.timeout_ms ||
        options.timeoutMs ||
        process.env.EVOLUTION_GROUP_SYNC_TIMEOUT_MS ||
        (getParticipants ? 0 : 180000)
    );

    if (!Number.isInteger(maturidade) || maturidade < 1 || maturidade > 4) {
      throw new Error("Maturidade must be between 1 and 4");
    }

    if (organizationId) {
      const organization = await organizationRepository.findById(organizationId);

      if (!organization) {
        throw new Error("Organization not found");
      }
    }

    const activeInstances = await instancesRepository.listActive();

    if (activeInstances.length === 0) {
      throw new Error("No active WhatsApp instances registered");
    }

    // Une os grupos de todas as instancias em uma unica passada, deduplicando
    // pelo JID (evolution_group_id) - o mesmo grupo pode aparecer em mais de
    // uma instancia quando varios dos nossos numeros sao membros dele.
    const groupsByJid = new Map();
    const groupIdsSeenByInstance = new Map();
    const failedInstances = [];
    let ignored = 0;

    // Best-effort: grava o resultado da tentativa (sucesso ou motivo do erro)
    // para a UI mostrar mesmo depois que a resposta deste sync deixar de estar
    // na tela. `instancesRepository.update` pode nao existir em stubs de teste.
    async function recordSyncAttempt(instanceId, payload) {
      if (typeof instancesRepository.update !== "function") {
        return;
      }

      await instancesRepository.update(instanceId, payload).catch(() => null);
    }

    for (const instance of activeInstances) {
      let response;
      const attemptedAt = new Date().toISOString();

      try {
        // Espalha evolutionConfig (baseUrl/apiKey/timeouts) antes de sobrescrever
        // instanceName - sem isso o provider ficava sem apiKey/baseUrl.
        response = await fetchEvolutionGroups({
          getParticipants,
          timeoutMs,
          config: { ...evolutionConfig, instanceName: instance.instance_name },
        });
      } catch (error) {
        // Uma instancia desconectada/com erro nao pode derrubar a sincronizacao
        // das demais - registra a falha e segue para a proxima instancia.
        const errorMessage = error?.message || String(error);

        failedInstances.push({
          instance_id: instance.id,
          instance_name: instance.instance_name,
          error_message: errorMessage,
        });
        groupIdsSeenByInstance.set(instance.id, new Set());

        await recordSyncAttempt(instance.id, { last_sync_attempt_at: attemptedAt, last_sync_error: errorMessage });

        continue;
      }

      await recordSyncAttempt(instance.id, { last_sync_attempt_at: attemptedAt, last_sync_error: null });

      const evolutionGroups = extractEvolutionGroups(response.data ?? response);
      const seenForInstance = new Set();

      for (const rawGroup of evolutionGroups) {
        const group = normalizeEvolutionGroup(rawGroup);

        if (!group || !matchesNameFilter(group, nameContains)) {
          ignored += 1;
          continue;
        }

        const dedupeKey = group.id.toLowerCase();

        if (seenForInstance.has(dedupeKey)) {
          ignored += 1;
          continue;
        }

        seenForInstance.add(dedupeKey);

        if (!groupsByJid.has(dedupeKey)) {
          groupsByJid.set(dedupeKey, { group, instanceIds: new Set() });
        }

        groupsByJid.get(dedupeKey).instanceIds.add(instance.id);
      }

      groupIdsSeenByInstance.set(instance.id, seenForInstance);
    }

    if (failedInstances.length === activeInstances.length) {
      const error = new Error(
        `Falha ao sincronizar com a Evolution API em todas as instancias ativas: ${failedInstances
          .map((entry) => `${entry.instance_name} (${entry.error_message})`)
          .join("; ")}`
      );
      error.code = "EVOLUTION_SYNC_ALL_FAILED";
      throw error;
    }

    const result = {
      inserted: 0,
      updated: 0,
      ignored,
      instances_synced: activeInstances.length,
      groups: [],
    };
    const persistedIdByDedupeKey = new Map();

    for (const [dedupeKey, entry] of groupsByJid) {
      const { group, instanceIds } = entry;
      const existing = await repository.findByEvolutionGroupId(group.id);
      const payload = {
        nome: group.nome,
        quantidade_membros: group.quantidade_membros,
      };

      let persisted;

      if (existing) {
        persisted = await repository.update(existing.id, payload);
        result.updated += 1;
      } else {
        persisted = await repository.create({
          ...payload,
          organization_id: organizationId,
          evolution_group_id: group.id,
          segmento: null,
          envia_video: false,
          maturidade,
        });
        result.inserted += 1;
      }

      persistedIdByDedupeKey.set(dedupeKey, persisted.id);

      for (const instanceId of instanceIds) {
        await groupInstancesRepository.linkGroupToInstance(persisted.id, instanceId);
      }

      result.groups.push({
        id: group.id,
        nome: persisted?.nome || group.nome,
        quantidade_membros: persisted?.quantidade_membros ?? group.quantidade_membros,
        instance_ids: [...instanceIds],
      });
    }

    const failedInstanceIds = new Set(failedInstances.map((entry) => entry.instance_id));

    for (const instance of activeInstances) {
      // Instancia que falhou na busca nao tem lista real de grupos atuais - remover
      // os vinculos dela aqui apagaria a sincronizacao anterior por causa de um erro
      // temporario (timeout, instancia desconectada), entao pula o unlink.
      if (failedInstanceIds.has(instance.id)) {
        continue;
      }

      const seenDedupeKeys = groupIdsSeenByInstance.get(instance.id) || new Set();
      const groupIdsStillPresent = [...seenDedupeKeys]
        .map((dedupeKey) => persistedIdByDedupeKey.get(dedupeKey))
        .filter(Boolean);

      await groupInstancesRepository.unlinkGroupsNotIn(instance.id, groupIdsStillPresent);
    }

    if (failedInstances.length > 0) {
      result.failed_instances = failedInstances;
    }

    return result;
  }

  async function dispatchTestVideo(id, payload = {}) {
    const group = await updateOperationalSettings(id, payload);

    if (group.envia_video !== true) {
      throw new Error("Group must have envia_video=true");
    }

    if (!group.evolution_group_id) {
      throw new Error("Evolution group id is required");
    }

    const profile = group.segmento;
    const trilhaId = group.trilha_id;

    if (!profile) {
      throw new Error("Segmento is required");
    }

    if (!trilhaId) {
      throw new Error("Trilha id is required");
    }

    await instancesService.assertGroupsDispatchable([group.id]);

    const video = await trilhasRepositoryDependency.findFirstApprovedVideoByTrilhaAndProfile(trilhaId, profile);

    if (!video) {
      throw new Error("No approved video found for trail");
    }

    if (!video.drive_file_id && !video.link_video) {
      throw new Error("Selected video has no drive_file_id or link_video");
    }

    const job = await enqueueDispatch(
      {
        group_id: group.evolution_group_id,
        progress_group_id: group.id,
        campaign_id: "manual-test",
        video_id: video.id,
        drive_file_id: video.drive_file_id,
        video_catalog: video.drive_file_id
          ? {
              ...video,
              name: video.nome_do_arquivo || video.name || video.file_name,
              mime_type: video.mime_type || "video/mp4",
            }
          : undefined,
        link_video: video.drive_file_id ? undefined : video.link_video,
        legenda: payload.legenda || `Teste: ${video.nome_do_arquivo || "video"}`,
        scheduled_at: new Date(),
      },
      {
        attempts: 1,
        timeout: 25 * 60 * 1000,
        removeOnComplete: false,
        removeOnFail: false,
      }
    );

    return {
      group,
      video,
      dispatch_job: {
        id: job.id,
        name: job.name,
        queue: job.queueName,
        data: job.data,
      },
    };
  }

  // Pre-visualizacao (nao persiste nada) da trilha que o motor de sequenciamento
  // automatico atribuiria a este grupo agora - usada pela tela de envio
  // automatizado para mostrar a "trilha recomendada" mesmo antes do primeiro
  // disparo, quando o grupo ainda nao tem trilha_id nenhum.
  async function previewNextTrilha(id) {
    if (!id) {
      throw new Error("Group id is required");
    }

    const group = await repository.findById(id);

    if (!group) {
      throw new Error("Group not found");
    }

    const next = await trilhaSequenceServiceDependency.resolveNextTrilhaForGroup(group);

    if (!next) {
      return null;
    }

    const trilha = await trilhasRepositoryDependency.findById(next.trilha_id);

    return {
      ...next,
      macrotema: trilha ? trilha.macrotema : null,
      trilha: trilha ? trilha.trilha : null,
    };
  }

  async function forceNextVideo(id, payload = {}) {
    if (!id) {
      throw new Error("Group id is required");
    }

    const videoId = payload.video_id || payload.videoId;

    if (!videoId) {
      throw new Error("Video id is required");
    }

    const group = await repository.findById(id);

    if (!group) {
      throw new Error("Group not found");
    }

    if (!group.trilha_id) {
      throw new Error("Group has no trilha selected");
    }

    const trailVideoLinks = await trilhasRepositoryDependency.listVideoLinksByTrilha(group.trilha_id);

    if (!trailVideoLinks.some((link) => link.video_id === videoId)) {
      throw new Error("Video does not belong to the group's current trilha");
    }

    const video = await videoCatalogRepositoryDependency.findById(videoId);

    if (!video) {
      throw new Error("Video not found");
    }

    return repository.update(id, { forced_next_video_id: videoId });
  }

  return {
    create,
    delete: remove,
    forceNextVideo,
    getById,
    list,
    listByInstance,
    listByOrganization,
    listVideoEnabled,
    listWithoutSegment,
    previewNextTrilha,
    search,
    dispatchTestVideo,
    syncGroupsFromEvolution,
    update,
    updateOperationalSettings,
  };
}

module.exports = createGroupsService();
module.exports.createGroupsService = createGroupsService;
