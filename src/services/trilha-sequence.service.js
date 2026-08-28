const trilhasRepository = require("../repositories/trilhas.repository");
const trilhaDesviosRepository = require("../repositories/trilha-desvios.repository");
const groupProfilesRepository = require("../repositories/group-profiles.repository");
const groupVideoProgressRepository = require("../repositories/group-video-progress.repository");

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

  // Cursor = posicao, na sequencia deste perfil, da trilha atualmente atribuida ao
  // grupo (group.trilha_id). Ancorar na trilha ao vivo (em vez do maior "ordem" ja
  // entregue) faz uma troca manual de trilha pelo operador realmente mudar qual e
  // a "proxima" - se o operador voltou da trilha 4 para a 1, a proxima passa a ser
  // a 2, mesmo que a 4 e a 5 ja tenham sido entregues antes.
  //
  // Se o grupo nao tem trilha_id atribuida (ainda nao comecou), cai de volta no
  // maior "ordem" ja entregue - preserva o comportamento de retomar de onde parou
  // apos uma entrega bem-sucedida que ainda nao foi refletida em group.trilha_id.
  async function findCursorIndex(sequence, group) {
    if (!sequence.length) {
      return -1;
    }

    const currentTrilhaId = group?.trilha_id || group?.trilhaId || null;

    if (currentTrilhaId) {
      const currentIndex = sequence.findIndex((entry) => entry.trilha_id === currentTrilhaId);

      if (currentIndex >= 0) {
        return currentIndex;
      }
    }

    const deliveries = await progressRepository.listDelivered(group?.id);
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
      .filter((desvio) => (desvio.after_trilha_id ?? null) === afterTrilhaId)
      .filter((desvio) => {
        const setores = Array.isArray(desvio.setores) ? desvio.setores : [];
        return setores.some((value) => normalizeComparableText(value) === normalizedSetor);
      })
      .sort((left, right) => new Date(left.created_at) - new Date(right.created_at));

    return candidates[0] || null;
  }

  // Resolve a trilha que o grupo deveria estar recebendo agora, segundo a ordem
  // pre-definida do seu perfil (mais desvios por setor). Nao persiste nada - quem
  // chama decide se/como grava o resultado.
  //
  // Nunca avanca para o proximo perfil sozinho: ao esgotar a sequencia do perfil
  // atual, devolve null (jornada deste perfil parada) mesmo que o proximo perfil
  // ja tenha trilhas cadastradas - a troca de perfil e sempre uma decisao manual
  // do operador (ver applyTrilhaChange / atualizar trilhas finalizadas na tela de
  // envio automatizado).
  //
  // options.excludeTrilhaIds (Set, opcional): trilhas que o chamador ja tentou
  // nesta mesma passada de avanco e sabe que estao sem video aprovado agora -
  // tratadas como "passadas" mesmo sem entrega real registrada, para o motor nao
  // ficar preso oferecendo a mesma trilha vazia. Ver firstNonExcluded.
  async function resolveDesvioTarget(desvios, anchorTrilhaId, group, excludeTrilhaIds) {
    const desvio = matchingDesvio(desvios, anchorTrilhaId, group.setor);

    if (!desvio || excludeTrilhaIds.has(desvio.trilha_destino_id)) {
      return null;
    }

    const alreadyReceived = await progressRepository.hasGroupReceivedTrilha(group.id, desvio.trilha_destino_id);

    if (alreadyReceived) {
      return null;
    }

    return desvio.trilha_destino_id;
  }

  async function resolveNextTrilhaForGroup(group, options = {}) {
    const profileId = group?.profile_id;

    if (!profileId) {
      return null;
    }

    const excludeTrilhaIds = options.excludeTrilhaIds instanceof Set ? options.excludeTrilhaIds : new Set();
    const { sequence, desvios } = await loadProfileContext(profileId);

    if (!sequence.length) {
      return null;
    }

    const cursor = await findCursorIndex(sequence, group);

    // cursor -1 = grupo ainda nao recebeu nenhuma trilha deste perfil. Antes de
    // cair na 1a trilha da sequencia, um "desvio inicial" (after_trilha_id nulo)
    // pode trocar por setor qual trilha o grupo recebe de cara - ver
    // buildSequencePathForSetor no frontend (trilhas.html), que simula esse mesmo
    // caso comecando pelo desvio ancorado em null antes de state.sequence[0].
    if (cursor === -1) {
      const initialDesvioTarget = await resolveDesvioTarget(desvios, null, group, excludeTrilhaIds);

      if (initialDesvioTarget) {
        return { trilha_id: initialDesvioTarget, profile_id: profileId, checkpoint: false, reason: "setor_desvio" };
      }
    }

    const anchor = sequence[Math.max(cursor, 0)];
    const desvioTarget = await resolveDesvioTarget(desvios, anchor.trilha_id, group, excludeTrilhaIds);

    if (desvioTarget) {
      return { trilha_id: desvioTarget, profile_id: profileId, checkpoint: false, reason: "setor_desvio" };
    }

    const next = firstNonExcluded(sequence, cursor + 1, excludeTrilhaIds);

    if (next) {
      return { trilha_id: next.trilha_id, profile_id: profileId, checkpoint: false, reason: "sequencia" };
    }

    return null;
  }

  // Limite de iteracao real para o laco de "pular trilha vazia" em
  // group-video-flow.js, em vez de uma constante arbitraria: soma os passos ainda
  // alcancaveis a partir do cursor atual, dentro do perfil corrente apenas - o
  // motor nunca avanca de perfil sozinho (ver resolveNextTrilhaForGroup), entao
  // perfis seguintes nunca sao alcancaveis pelo avanco automatico.
  async function countReachableSteps(group) {
    const profileId = group?.profile_id;

    if (!profileId) {
      return 0;
    }

    const { sequence, desvios } = await loadProfileContext(profileId);
    const cursor = await findCursorIndex(sequence, group);

    return Math.max(sequence.length - (cursor + 1), 0) + desvios.length;
  }

  async function listDesviosByProfile(profileId) {
    if (!profileId) {
      throw new Error("Profile id is required");
    }

    return desviosRepository.listByProfile(profileId);
  }

  async function createDesvio(payload) {
    const profileId = String(payload?.profile_id || "").trim();
    // after_trilha_id ausente/vazio = "desvio inicial": para o setor, comece por
    // trilha_destino_id em vez da 1a trilha da sequencia do perfil (ver
    // resolveNextTrilhaForGroup e buildSequencePathForSetor em trilhas.html).
    const afterTrilhaId = String(payload?.after_trilha_id || "").trim() || null;
    const trilhaDestinoId = String(payload?.trilha_destino_id || "").trim();
    const setores = Array.isArray(payload?.setores)
      ? Array.from(new Set(payload.setores.map((setor) => String(setor || "").trim()).filter(Boolean)))
      : [];

    if (!profileId) {
      throw new Error("Profile id is required");
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
      afterTrilhaId ? repository.findById(afterTrilhaId) : Promise.resolve(null),
      repository.findById(trilhaDestinoId),
    ]);

    if (afterTrilhaId && !afterTrilha) {
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
      if ((desvio.after_trilha_id ?? null) !== afterTrilhaId) {
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
