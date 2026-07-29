const whatsappInstancesRepository = require("../repositories/whatsapp-instances.repository");
const groupWhatsappInstancesRepository = require("../repositories/group-whatsapp-instances.repository");
const settingsRepository = require("../repositories/settings.repository");
const {
  createEvolutionInstance,
  connectEvolutionInstance,
  getEvolutionConnectionState,
  deleteEvolutionInstance,
  listEvolutionInstances,
} = require("./evolution-instances");
const { evolutionConfig } = require("../config/evolution");

// Duracao fixa exibida no contador da tela de Configuracoes. E apenas uma
// convencao de UI: quem expira o QR de fato e a propria Evolution/Baileys.
const QR_EXPIRY_SECONDS = 45;
const VALID_CONNECTION_STATES = ["open", "connecting", "close"];

// GET /instance/fetchInstances retorna o numero conectado em `ownerJid`
// (formato "<numero>@s.whatsapp.net"), confirmado via chamada real contra a
// Evolution API v2 (evoapicloud/evolution-api). GET /instance/connectionState
// nao traz esse campo, por isso o numero e obtido separadamente.
function extractPhoneNumberFromOwnerJid(ownerJid) {
  if (!ownerJid || typeof ownerJid !== "string") {
    return null;
  }

  return ownerJid.split("@")[0] || null;
}

function createWhatsappInstancesService(dependencies = {}) {
  const repository = dependencies.repository || whatsappInstancesRepository;
  const groupLinksRepository = dependencies.groupLinksRepository || groupWhatsappInstancesRepository;
  const settingsRepo = dependencies.settingsRepository || settingsRepository;
  const createInstance = dependencies.createEvolutionInstance || createEvolutionInstance;
  const connectInstance = dependencies.connectEvolutionInstance || connectEvolutionInstance;
  const getConnectionState = dependencies.getEvolutionConnectionState || getEvolutionConnectionState;
  const deleteInstance = dependencies.deleteEvolutionInstance || deleteEvolutionInstance;
  const listInstances = dependencies.listEvolutionInstances || listEvolutionInstances;

  async function list() {
    return repository.findAll();
  }

  async function testConnection() {
    try {
      await listInstances();

      return { connected: true };
    } catch (error) {
      return { connected: false, reason: error.message };
    }
  }

  // Backfill idempotente: se nenhuma instancia estiver cadastrada, registra a
  // instancia unica ja configurada via env como prioridade 0, preservando o
  // comportamento atual para quem so tem um numero, sem chamar a Evolution API
  // (ela ja deve estar criada/conectada la fora).
  async function ensureLegacyInstanceRegistered() {
    const existing = await repository.findAll();

    if (existing.length > 0) {
      return null;
    }

    return repository.create({
      instance_name: evolutionConfig.instanceName,
      phone_number: null,
      connection_state: "open",
      priority: 0,
      active: true,
      connected_at: new Date().toISOString(),
    });
  }

  async function registerInstance(payload = {}) {
    const instanceName = String(payload.instance_name || "").trim();

    if (!instanceName) {
      throw new Error("instance_name is required");
    }

    const existing = await repository.findByInstanceName(instanceName);

    if (existing) {
      throw new Error("Instance already exists");
    }

    const allInstances = await repository.findAll();
    const nextPriority = allInstances.length;

    await createInstance(instanceName);

    return repository.create({
      instance_name: instanceName,
      phone_number: payload.phone_number || null,
      connection_state: "pending",
      priority: nextPriority,
      active: true,
    });
  }

  async function generateQrCode(id) {
    const instance = await repository.findById(id);

    if (!instance) {
      throw new Error("Instance not found");
    }

    const response = await connectInstance(instance.instance_name);
    const qrPayload = response.data && (response.data.base64 || response.data.qrcode || response.data.code);

    if (!qrPayload) {
      throw new Error("Evolution API did not return a QR code");
    }

    await repository.update(id, {
      connection_state: "connecting",
      qr_generated_at: new Date().toISOString(),
    });

    return {
      instance_id: id,
      instance_name: instance.instance_name,
      qr_base64: qrPayload,
      expires_in_seconds: QR_EXPIRY_SECONDS,
      expires_at: new Date(Date.now() + QR_EXPIRY_SECONDS * 1000).toISOString(),
    };
  }

  async function checkConnectionStatus(id) {
    const instance = await repository.findById(id);

    if (!instance) {
      throw new Error("Instance not found");
    }

    const response = await getConnectionState(instance.instance_name);
    const rawState = String(
      (response.data && response.data.instance && response.data.instance.state) ||
        (response.data && response.data.state) ||
        "close"
    ).toLowerCase();
    const normalizedState = VALID_CONNECTION_STATES.includes(rawState) ? rawState : "close";

    const updatePayload = {
      connection_state: normalizedState,
      last_status_check_at: new Date().toISOString(),
    };

    if (normalizedState === "open" && !instance.connected_at) {
      updatePayload.connected_at = new Date().toISOString();
    }

    if (normalizedState === "open" && !instance.phone_number) {
      const fetchResponse = await listInstances({ instanceName: instance.instance_name }).catch(() => null);
      const fetched = Array.isArray(fetchResponse && fetchResponse.data) ? fetchResponse.data[0] : null;
      const phoneNumber = fetched && extractPhoneNumberFromOwnerJid(fetched.ownerJid);

      if (phoneNumber) {
        updatePayload.phone_number = phoneNumber;
      }
    }

    return repository.update(id, updatePayload);
  }

  async function removeInstance(id) {
    const instance = await repository.findById(id);

    if (!instance) {
      throw new Error("Instance not found");
    }

    await deleteInstance(instance.instance_name);

    // ON DELETE CASCADE em group_whatsapp_instances.whatsapp_instance_id remove
    // automaticamente os vinculos dessa instancia com qualquer grupo.
    await repository.delete(id);

    const remaining = await repository.listActive();
    await repository.reorderPriorities(remaining.map((row) => row.id));

    return { removed: true, instance_id: id };
  }

  async function reorderPriority(orderedIds) {
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      throw new Error("orderedIds must be a non-empty array");
    }

    return repository.reorderPriorities(orderedIds);
  }

  async function getRotationSettings() {
    const settings = await settingsRepo.getSettings();

    return {
      whatsapp_rotation_group_count: (settings && settings.whatsapp_rotation_group_count) || 1,
    };
  }

  async function updateRotationSettings(payload = {}) {
    const rotationCount = Number(payload.whatsapp_rotation_group_count);

    if (!Number.isInteger(rotationCount) || rotationCount < 1) {
      throw new Error("whatsapp_rotation_group_count must be an integer greater than or equal to 1");
    }

    await settingsRepo.updateSettings({ whatsapp_rotation_group_count: rotationCount });

    return getRotationSettings();
  }

  async function resolveMissingCoverage(groupIds) {
    const activeInstances = await repository.listActive();

    if (activeInstances.length <= 1) {
      return { activeInstances, missing: [] };
    }

    const linksByGroup = await groupLinksRepository.listInstanceIdsByGroupIds(groupIds);
    const activeIds = activeInstances.map((instance) => instance.id);

    const missing = groupIds.filter((groupId) => {
      const linked = linksByGroup.get(groupId) || new Set();
      return !activeIds.every((instanceId) => linked.has(instanceId));
    });

    return { activeInstances, missing };
  }

  // Bloqueia (lanca erro) quando algum grupo nao estiver vinculado a todas as
  // instancias ativas. Usado no disparo manual de teste, onde uma falha dura
  // em uma unica acao explicita do usuario e o comportamento correto.
  async function assertGroupsDispatchable(groupIds) {
    const { missing } = await resolveMissingCoverage(groupIds);

    if (missing.length > 0) {
      const error = new Error("Groups missing coverage on all active WhatsApp instances");
      error.code = "GROUPS_MISSING_INSTANCE_COVERAGE";
      error.groupIds = missing;
      throw error;
    }
  }

  // Filtra grupos elegiveis sem lancar erro. Usado no fluxo de disparo em lote
  // (campanhas), onde um grupo sem cobertura completa deve ser pulado, nao
  // deve abortar a campanha inteira.
  async function filterDispatchableGroups(groupIds) {
    const { missing } = await resolveMissingCoverage(groupIds);
    const missingSet = new Set(missing);

    return {
      eligible: groupIds.filter((groupId) => !missingSet.has(groupId)),
      ineligible: missing,
    };
  }

  return {
    assertGroupsDispatchable,
    checkConnectionStatus,
    ensureLegacyInstanceRegistered,
    filterDispatchableGroups,
    generateQrCode,
    getRotationSettings,
    list,
    registerInstance,
    removeInstance,
    reorderPriority,
    testConnection,
    updateRotationSettings,
  };
}

module.exports = createWhatsappInstancesService();
module.exports.createWhatsappInstancesService = createWhatsappInstancesService;
