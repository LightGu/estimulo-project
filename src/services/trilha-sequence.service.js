const trilhasRepository = require("../repositories/trilhas.repository");
const trilhaDesviosRepository = require("../repositories/trilha-desvios.repository");
const groupProfilesRepository = require("../repositories/group-profiles.repository");
const groupVideoProgressRepository = require("../repositories/group-video-progress.repository");

const MAX_PROFILE_HOPS = 50;

function normalizeComparableText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

function createTrilhaSequenceService(dependencies = {}) {
  const repository = dependencies.trilhasRepository || trilhasRepository;
  const desviosRepository = dependencies.trilhaDesviosRepository || trilhaDesviosRepository;
  const profilesRepository = dependencies.groupProfilesRepository || groupProfilesRepository;
  const progressRepository = dependencies.groupVideoProgressRepository || groupVideoProgressRepository;

  async function loadProfileContext(profileId) {
    const [sequence, desvios] = await Promise.all([
      repository.listTrilhaPerfisByProfile(profileId),
      desviosRepository.listByProfile(profileId),
    ]);

    return {
      sequence: [...sequence].sort((left, right) => Number(left.ordem) - Number(right.ordem)),
      desvios,
    };
  }

  // Cursor = maior ordem, na sequencia deste perfil, entre trilhas que o grupo ja
  // recebeu de verdade (entrega registrada, nao so atribuicao ao vivo em
  // group.trilha_id). Tratar trilha_id como "o que entregar agora" em vez de "onde
  // estamos" evita que uma troca manual de trilha pelo operador reinicie o perfil
  // do zero, e torna corridas de concorrencia no avanco automatico nao-destrutivas.
  async function findCursorIndex(sequence, groupId) {
    if (!sequence.length) {
      return -1;
    }

    const deliveries = await progressRepository.listDelivered(groupId);
    const deliveredTrilhaIds = new Set(
      deliveries.filter((delivery) => delivery.trilha_id && delivery.enviado_em).map((delivery) => delivery.trilha_id)
    );

    let cursor = -1;

    sequence.forEach((entry, index) => {
      if (deliveredTrilhaIds.has(entry.trilha_id)) {
        cursor = Math.max(cursor, index);
      }
    });

    return cursor;
  }

  // A partir de fromIndex, acha a primeira entrada da sequencia cujo trilha_id nao
  // esta em excludeTrilhaIds (trilhas que o chamador ja tentou nesta mesma passada
  // de avanco e descobriu que nao tem video aprovado disponivel agora - ver
  // resolveNextTrilhaForGroup). Sem isso, uma trilha com zero videos aprovados
  // nunca acumula entrega real, o cursor baseado em historico nunca passa dela, e
  // o motor ficaria devolvendo a mesma trilha vazia para sempre.
  function firstNonExcluded(sequence, fromIndex, excludeTrilhaIds) {
    for (let index = fromIndex; index < sequence.length; index += 1) {
      if (!excludeTrilhaIds.has(sequence[index].trilha_id)) {
        return sequence[index];
      }
    }

    return null;
  }

  function matchingDesvio(desvios, afterTrilhaId, setor) {
    const normalizedSetor = normalizeComparableText(setor);

    if (!normalizedSetor) {
      return null;
    }

    const candidates = desvios
      .filter((desvio) => desvio.after_trilha_id === afterTrilhaId)
      .filter((desvio) => {
        const setores = Array.isArray(desvio.setores) ? desvio.setores : [];
        return setores.some((value) => normalizeComparableText(value) === normalizedSetor);
      })
      .sort((left, right) => new Date(left.created_at) - new Date(right.created_at));

    return candidates[0] || null;
  }

  async function findNextProfile(currentProfileId, profiles) {
    const resolvedProfiles = profiles || (await profilesRepository.findAll());
    const current = resolvedProfiles.find((profile) => profile.id === currentProfileId);

    if (!current || current.ordem === null || current.ordem === undefined) {
      return null;
    }

    return resolvedProfiles.find((profile) => Number(profile.ordem) === Number(current.ordem) + 1) || null;
  }

  // Encadeia perfis seguintes ate achar um com sequencia cadastrada, ou esgotar os
  // perfis (retorna null - jornada concluida). O laco e defensivo: como
  // group_profiles.ordem tem UNIQUE constraint e cada passo exige ordem+1 exato,
  // nao ha como formar um ciclo; o teto so existe para nunca travar caso os dados
  // fiquem em um estado inesperado.
  async function resolveCheckpoint(currentProfileId, excludeTrilhaIds) {
    const profiles = await profilesRepository.findAll();
    let cursorProfileId = currentProfileId;

    for (let hops = 0; hops < MAX_PROFILE_HOPS; hops += 1) {
      const nextProfile = await findNextProfile(cursorProfileId, profiles);

      if (!nextProfile) {
        return null;
      }

      const { sequence } = await loadProfileContext(nextProfile.id);
      const firstAvailable = firstNonExcluded(sequence, 0, excludeTrilhaIds);

      if (firstAvailable) {
        return { trilha_id: firstAvailable.trilha_id, profile_id: nextProfile.id, checkpoint: true, reason: "checkpoint_perfil" };
      }

      cursorProfileId = nextProfile.id;
    }

    return null;
  }

  // Resolve a trilha que o grupo deveria estar recebendo agora, segundo a ordem
  // pre-definida do seu perfil (mais desvios por setor e checkpoints de perfil).
  // Nao persiste nada - quem chama decide se/como grava o resultado.
  //
  // options.excludeTrilhaIds (Set, opcional): trilhas que o chamador ja tentou
  // nesta mesma passada de avanco e sabe que estao sem video aprovado agora -
  // tratadas como "passadas" mesmo sem entrega real registrada, para o motor nao
  // ficar preso oferecendo a mesma trilha vazia. Ver firstNonExcluded.
  async function resolveNextTrilhaForGroup(group, options = {}) {
    const profileId = group?.profile_id;

    if (!profileId) {
      return null;
    }

    const excludeTrilhaIds = options.excludeTrilhaIds instanceof Set ? options.excludeTrilhaIds : new Set();
    const { sequence, desvios } = await loadProfileContext(profileId);

    if (!sequence.length) {
      return resolveCheckpoint(profileId, excludeTrilhaIds);
    }

    const cursor = await findCursorIndex(sequence, group.id);

    if (cursor >= 0) {
      const anchor = sequence[cursor];
      const desvio = matchingDesvio(desvios, anchor.trilha_id, group.setor);

      if (desvio && !excludeTrilhaIds.has(desvio.trilha_destino_id)) {
        const alreadyReceived = await progressRepository.hasGroupReceivedTrilha(group.id, desvio.trilha_destino_id);

        if (!alreadyReceived) {
          return { trilha_id: desvio.trilha_destino_id, profile_id: profileId, checkpoint: false, reason: "setor_desvio" };
        }
      }
    }

    const next = firstNonExcluded(sequence, cursor + 1, excludeTrilhaIds);

    if (next) {
      return { trilha_id: next.trilha_id, profile_id: profileId, checkpoint: false, reason: "sequencia" };
    }

    return resolveCheckpoint(profileId, excludeTrilhaIds);
  }

  // Limite de iteracao real para o laco de "pular trilha vazia" em
  // group-video-flow.js, em vez de uma constante arbitraria: soma os passos ainda
  // alcancaveis a partir do cursor atual (resto da sequencia do perfil corrente +
  // sequencias completas dos perfis seguintes + desvios de cada um).
  async function countReachableSteps(group) {
    const profileId = group?.profile_id;

    if (!profileId) {
      return 0;
    }

    const profiles = await profilesRepository.findAll();
    const current = profiles.find((profile) => profile.id === profileId);

    if (!current) {
      return 0;
    }

    const relevantProfiles =
      current.ordem === null || current.ordem === undefined
        ? [current]
        : profiles.filter((profile) => Number(profile.ordem) >= Number(current.ordem));

    let total = 0;

    for (const profile of relevantProfiles) {
      const { sequence, desvios } = await loadProfileContext(profile.id);

      if (profile.id === profileId) {
        const cursor = await findCursorIndex(sequence, group.id);
        total += Math.max(sequence.length - (cursor + 1), 0);
      } else {
        total += sequence.length;
      }

      total += desvios.length;
    }

    return total;
  }

  async function listDesviosByProfile(profileId) {
    if (!profileId) {
      throw new Error("Profile id is required");
    }

    return desviosRepository.listByProfile(profileId);
  }

  async function createDesvio(payload) {
    const profileId = String(payload?.profile_id || "").trim();
    const afterTrilhaId = String(payload?.after_trilha_id || "").trim();
    const trilhaDestinoId = String(payload?.trilha_destino_id || "").trim();
    const setores = Array.isArray(payload?.setores)
      ? Array.from(new Set(payload.setores.map((setor) => String(setor || "").trim()).filter(Boolean)))
      : [];

    if (!profileId) {
      throw new Error("Profile id is required");
    }

    if (!afterTrilhaId) {
      throw new Error("After trilha id is required");
    }

    if (!trilhaDestinoId) {
      throw new Error("Trilha destino id is required");
    }

    if (!setores.length) {
      throw new Error("At least one setor is required");
    }

    const profiles = await profilesRepository.findAll();

    if (!profiles.some((profile) => profile.id === profileId)) {
      throw new Error("Profile not found");
    }

    const [afterTrilha, trilhaDestino] = await Promise.all([
      repository.findById(afterTrilhaId),
      repository.findById(trilhaDestinoId),
    ]);

    if (!afterTrilha) {
      throw new Error("After trilha not found");
    }

    if (!trilhaDestino) {
      throw new Error("Trilha destino not found");
    }

    // Duas regras no mesmo ponto de ancoragem com setores sobrepostos tornam
    // ambiguo qual desvio deveria disparar - rejeita antes de criar em vez de
    // depender so do desempate por created_at em tempo de resolucao.
    const existing = await desviosRepository.listByProfile(profileId);
    const normalizedNewSetores = new Set(setores.map(normalizeComparableText));
    const overlapping = existing.find((desvio) => {
      if (desvio.after_trilha_id !== afterTrilhaId) {
        return false;
      }

      const desvioSetores = Array.isArray(desvio.setores) ? desvio.setores : [];
      return desvioSetores.some((setor) => normalizedNewSetores.has(normalizeComparableText(setor)));
    });

    if (overlapping) {
      throw new Error("Setor already has a desvio at this point in the sequence");
    }

    return desviosRepository.create({
      profile_id: profileId,
      after_trilha_id: afterTrilhaId,
      trilha_destino_id: trilhaDestinoId,
      setores,
    });
  }

  async function removeDesvio(id) {
    const trimmed = String(id || "").trim();

    if (!trimmed) {
      throw new Error("Desvio id is required");
    }

    const desvio = await desviosRepository.findById(trimmed);

    if (!desvio) {
      throw new Error("Desvio not found");
    }

    return desviosRepository.remove(trimmed);
  }

  return {
    countReachableSteps,
    createDesvio,
    listDesviosByProfile,
    removeDesvio,
    resolveNextTrilhaForGroup,
  };
}

module.exports = createTrilhaSequenceService();
module.exports.createTrilhaSequenceService = createTrilhaSequenceService;
