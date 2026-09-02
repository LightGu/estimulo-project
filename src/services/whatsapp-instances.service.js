const whatsappInstancesRepository = require("../repositories/whatsapp-instances.repository");
const groupWhatsappInstancesRepository = require("../repositories/group-whatsapp-instances.repository");
const settingsRepository = require("../repositories/settings.repository");
const groupsRepository = require("../repositories/groups.repository");
const {
  createEvolutionInstance,
  connectEvolutionInstance,
  getEvolutionConnectionState,
  deleteEvolutionInstance,
  listEvolutionInstances,
} = require("./evolution-instances");
const { evolutionConfig } = require("../config/evolution");
const { toSafeInstanceName, resolveInstanceNames } = require("./evolution-instance-resolver");

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
  const groupsRepo = dependencies.groupsRepository || groupsRepository;
  const createInstance = dependencies.createEvolutionInstance || createEvolutionInstance;
  const connectInstance = dependencies.connectEvolutionInstance || connectEvolutionInstance;
  const getConnectionState = dependencies.getEvolutionConnectionState || getEvolutionConnectionState;
  const deleteInstance = dependencies.deleteEvolutionInstance || deleteEvolutionInstance;
  const listInstances = dependencies.listEvolutionInstances || listEvolutionInstances;
  // Mesmo resolvedor de nome usado no caminho de envio: o teste de conexao
  // precisa aprovar/reprovar exatamente o que o disparo consegue usar.
  const resolveNames = dependencies.resolveInstanceNames || resolveInstanceNames;

  // A listagem da tela de Configuracoes.
  //
  // `connection_state` no banco e' um valor GRAVADO por algum check anterior,
  // nao uma consulta ao vivo - entao uma instancia que sumiu da Evolution
  // continuava aparecendo como "Conectado" indefinidamente. Era o caso de
  // "sophiaEstimulo": badge verde na tela enquanto todo disparo por ele falhava
  // com 404 "instance does not exist", e a propria tela ainda escondia o botao
  // "Conectar" (so aparece quando o estado != open), deixando o operador sem
  // como corrigir o que a tela dizia nao estar quebrado.
  //
  // Aqui o estado gravado e' confrontado com a lista autoritativa da Evolution,
  // pelo MESMO resolvedor do caminho de envio: sem instancia correspondente la,
  // a linha sai como "close" - que e' a verdade operacional (nao da para enviar
  // por ela) e reativa o botao "Conectar".
  //
  // Best-effort de proposito: se a Evolution nao responder, devolve o estado
  // gravado em vez de marcar tudo como desconectado. Uma indisponibilidade
  // momentanea da API nao e' o mesmo que numero descadastrado, e apagar os
  // badges nesse caso seria outro tipo de mentira.
  async function list() {
    const instances = await repository.findAll();

    if (!instances || instances.length === 0) {
      return instances || [];
    }

    let remoteResolution;

    try {
      remoteResolution = await resolveNames(instances, { listEvolutionInstances: listInstances });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "whatsapp_instances.list.remote_check_failed",
          error_message: error?.message,
        })
      );

      return instances;
    }

    const missingIds = new Set(
      remoteResolution.filter((entry) => !entry.remoteName).map((entry) => entry.instance.id)
    );

    if (missingIds.size === 0) {
      return instances;
    }

    // `missing_on_evolution` deixa a tela distinguir "desconectou do WhatsApp"
    // (leia o QR de novo) de "nao existe mais na Evolution" (o cadastro esta
    // orfao) - dois problemas com a mesma cara e solucoes diferentes.
    return instances.map((instance) =>
      missingIds.has(instance.id)
        ? { ...instance, connection_state: "close", missing_on_evolution: true }
        : instance
    );
  }

  // Stubs de teste e repositorios antigos podem nao ter listDispatchable; nesse
  // caso cai para listActive e filtra paused_at em memoria, preservando a
  // semantica de pausa sem exigir que todo mock implemente o metodo novo.
  async function listDispatchableInstances() {
    if (typeof repository.listDispatchable === "function") {
      return repository.listDispatchable();
    }

    const active = await repository.listActive();

    return (active || []).filter((instance) => !instance.paused_at);
  }

  // O teste de conexao da tela de Configuracoes.
  //
  // Antes so chamava listInstances() e devolvia { connected: true } se a
  // Evolution respondesse. Isso responde "a Evolution esta no ar?", nao "os
  // numeros cadastrados funcionam?" - e as duas coisas divergem exatamente no
  // caso que mais importa: um numero cadastrado aqui que nao existe la. Foi o
  // que aconteceu com "sophiaEstimulo" (linha no banco com
  // connection_state=open, nenhuma instancia correspondente na Evolution): a
  // tela dizia "Conectado com sucesso" enquanto todo disparo por aquele numero
  // falhava com 404 "The \"sophiaEstimulo\" instance does not exist". O
  // connection_state que a tela mostra tambem nao ajuda a perceber - e um valor
  // gravado no banco por algum check anterior, nao uma consulta ao vivo.
  //
  // Agora confere cada instancia cadastrada contra a lista autoritativa da
  // Evolution, usando o MESMO resolvedor de nome do caminho de envio
  // (resolveInstanceNames): o que o teste aprova e' o que o disparo consegue
  // usar de fato. Assim um nome divergente que a rede de seguranca resolve
  // (banco "Estimulo Novo" vs. Evolution "estimulo-novo") continua passando,
  // e um numero que nao existe la reprova.
  async function testConnection() {
    let remoteResolution;

    try {
      const registered = await repository.findAll();

      // Sem numero cadastrado nao ha o que conferir: o teste volta a ser
      // apenas "a Evolution responde?", que e a informacao util nesse estado
      // (e o que a tela mostra antes do primeiro cadastro).
      if (!registered || registered.length === 0) {
        await listInstances();

        return { connected: true };
      }

      remoteResolution = await resolveNames(registered, { listEvolutionInstances: listInstances });
    } catch (error) {
      return { connected: false, reason: error.message };
    }

    const missing = remoteResolution
      .filter((entry) => !entry.remoteName)
      .map((entry) => entry.instance.instance_name);

    if (missing.length > 0) {
      return {
        connected: false,
        reason:
          `Numero(s) sem instancia correspondente na Evolution API: ${missing.join(", ")}. ` +
          "Reconecte o numero (leia o QR Code novamente) ou pause-o para que os disparos nao tentem usa-lo.",
        missing_instances: missing,
      };
    }

    return { connected: true };
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
    const rawInstanceName = String(payload.instance_name || "").trim();

    if (!rawInstanceName) {
      throw new Error("instance_name is required");
    }

    // camelCase, minusculo, sem espaco/acento/pontuacao: e' o mesmo texto que
    // vai cru no path de toda chamada a Evolution
    // (`/group/fetchAllGroups/:instance`, `/message/sendText/:instance`, ...).
    // Normalizar aqui, antes de criar na Evolution, evita o 404
    // "instance does not exist" que aparecia quando o nome digitado tinha
    // acento/espaco e a Evolution guardava/normalizava diferente do nosso
    // banco (ver evolution-instance-resolver.js, que so RECUPERA esse
    // descompasso depois de acontecer).
    const instanceName = toSafeInstanceName(rawInstanceName);

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

    // 404 "instance does not exist" nao pode subir como erro: era o que
    // mantinha o connection_state=open gravado de um check antigo para sempre,
    // porque a funcao estourava ANTES do repository.update - a instancia sumia
    // da Evolution e a tela seguia mostrando "Conectado". Instancia inexistente
    // e' um estado conhecido, e o estado correto para ela e' "close".
    // Outros erros (Evolution fora do ar, timeout) continuam subindo: nao sao
    // conclusao sobre a instancia, e gravar "close" neles seria um falso
    // negativo que apaga o estado real.
    let response = null;
    let missingOnEvolution = false;

    try {
      response = await getConnectionState(instance.instance_name);
    } catch (error) {
      // Casa por status HTTP (o EvolutionApiError carrega `status`), com o
      // texto como reserva para erros que cheguem sem ele.
      const naoExiste = error?.status === 404 || /does not exist/i.test(String(error?.message || ""));

      if (!naoExiste) {
        throw error;
      }

      missingOnEvolution = true;
    }

    const rawState = missingOnEvolution
      ? "close"
      : String(
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

    const updated = await repository.update(id, updatePayload);

    // Mesmo flag que list() usa, para a tela mostrar "Nao encontrado na
    // Evolution" em vez de um "Desconectado" generico que sugeriria que basta
    // ler o QR Code de novo.
    return missingOnEvolution ? { ...updated, missing_on_evolution: true } : updated;
  }

  // Pausar mantem a instancia conectada na Evolution (nenhuma chamada e feita
  // la fora): so marca no banco que a plataforma nao deve mais usar esse numero
  // para enviar. Despausar e o inverso, e o numero volta ao rodizio na mesma
  // prioridade que ja tinha - por isso a prioridade nao e mexida aqui.
  async function setInstancePaused(id, paused) {
    const instance = await repository.findById(id);

    if (!instance) {
      throw new Error("Instance not found");
    }

    return repository.update(id, { paused_at: paused ? new Date().toISOString() : null });
  }

  async function pauseInstance(id) {
    return setInstancePaused(id, true);
  }

  async function resumeInstance(id) {
    return setInstancePaused(id, false);
  }

  // Grupos so existem no banco porque algum numero conectado enxerga eles. Ao
  // desconectar um numero, os grupos que SO ele enxergava ficam orfaos: nenhum
  // numero restante consegue disparar neles. Esta funcao devolve exatamente esse
  // conjunto - os grupos vinculados a instancia removida menos os que tambem
  // estao vinculados a alguma instancia que permanece (os "comuns", que o outro
  // numero continua acessando). Com um unico numero cadastrado, nao sobra
  // ninguem para cobrir nada e todos os grupos dele entram na lista.
  async function resolveOrphanGroupIds(removedInstanceId) {
    const linkedToRemoved = await groupLinksRepository.listGroupIdsForInstance(removedInstanceId);

    if (linkedToRemoved.length === 0) {
      return [];
    }

    const allInstances = await repository.findAll();
    const survivingIds = allInstances
      .map((row) => row.id)
      .filter((instanceId) => instanceId !== removedInstanceId);

    if (survivingIds.length === 0) {
      return linkedToRemoved;
    }

    const coveredBySurvivors = new Set(await groupLinksRepository.listGroupIdsForInstances(survivingIds));

    return linkedToRemoved.filter((groupId) => !coveredBySurvivors.has(groupId));
  }

  async function removeInstance(id) {
    const instance = await repository.findById(id);

    if (!instance) {
      throw new Error("Instance not found");
    }

    // Resolvido ANTES do delete: o ON DELETE CASCADE em
    // group_whatsapp_instances.whatsapp_instance_id apaga os vinculos junto com a
    // instancia, e depois disso nao da mais pra saber quais grupos eram dela.
    const orphanGroupIds = await resolveOrphanGroupIds(id);

    // A remocao local NAO pode ficar refem do estado da Evolution. Antes,
    // qualquer erro daqui (Evolution fora do ar, timeout, 500) subia e o
    // controller respondia "Internal server error" generico - o numero ficava
    // impossivel de remover pela tela, sem dizer o porque. O 404 ja era
    // tolerado dentro de deleteEvolutionInstance pelo mesmo motivo; aqui
    // estendemos a tolerancia aos demais erros, registrando o que houve.
    let evolutionDeleteError = null;

    try {
      await deleteInstance(instance.instance_name);
    } catch (error) {
      evolutionDeleteError = error?.message || String(error);

      console.error(
        JSON.stringify({
          event: "whatsapp_instances.remove.evolution_delete_failed",
          instance_id: id,
          instance_name: instance.instance_name,
          error_message: evolutionDeleteError,
        })
      );
    }

    // ON DELETE CASCADE em group_whatsapp_instances.whatsapp_instance_id remove
    // automaticamente os vinculos dessa instancia com qualquer grupo.
    await repository.delete(id);

    // Os grupos sem cobertura saem do banco; os comuns a outro numero ficam,
    // para que o numero restante continue disparando neles.
    const removedGroups = await groupsRepo.removeMany(orphanGroupIds);

    const remaining = await repository.listActive();
    await repository.reorderPriorities(remaining.map((row) => row.id));

    return {
      removed: true,
      instance_id: id,
      removed_group_ids: orphanGroupIds,
      removed_groups_count: Array.isArray(removedGroups) ? removedGroups.length : orphanGroupIds.length,
      // Preenchido so quando o numero saiu daqui mas continua existindo na
      // Evolution: a tela avisa para remover por la, em vez de deixar um
      // orfao silencioso ocupando sessao no servidor da Evolution.
      evolution_delete_error: evolutionDeleteError,
    };
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

  // Le listDispatchable (nao listActive) de proposito: um numero pausado nao
  // envia nada, entao exigir que os grupos estejam vinculados a ele tambem so
  // produziria falso "grupo dessincronizado" e bloquearia disparos que os
  // numeros ativos conseguiriam fazer sem problema.
  async function resolveMissingCoverage(groupIds) {
    const activeInstances = await listDispatchableInstances();

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
    listDispatchableInstances,
    pauseInstance,
    registerInstance,
    removeInstance,
    reorderPriority,
    resolveOrphanGroupIds,
    resumeInstance,
    setInstancePaused,
    testConnection,
    updateRotationSettings,
  };
}

module.exports = createWhatsappInstancesService();
module.exports.createWhatsappInstancesService = createWhatsappInstancesService;
