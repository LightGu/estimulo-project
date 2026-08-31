const { EvolutionDeliveryProvider, sendToEvolution } = require("./evolution");
const { evolutionConfig } = require("../config/evolution");
const defaultWhatsappInstancesRepository = require("../repositories/whatsapp-instances.repository");

// Resolve o sender a ser usado em um envio: com whatsapp_instance_id valido,
// monta um EvolutionDeliveryProvider apontando para essa instancia; sem id
// (instalacoes com um unico numero, disparo de teste, ou compatibilidade
// retroativa) ou com um id que nao existe mais, cai para a PRIMEIRA instancia
// ativa por prioridade - nunca para o nome fixo em EVOLUTION_INSTANCE_NAME.
//
// Antes o fallback era `sendToEvolution` puro, que usa evolutionConfig.instanceName
// (o default do .env, historicamente "estimulo-mvp"). Assim que essa instancia
// era removida da Evolution (o caso normal ao trocar de numero), todo envio sem
// instance_id explicito - inclusive o botao "Enviar teste para este grupo" -
// quebrava com 404 "instance does not exist", mesmo havendo um numero
// perfeitamente configurado e conectado no banco.
//
// Vive fora de queues/dispatch.js porque o caminho de mensagem pontual
// agendada (queues/mensagens-dispatch.js) precisa da mesma resolucao, e
// importar dispatch.js de la arrastaria Google Drive e ffmpeg para dentro de um
// worker que so envia texto.
// Mesma resolucao de resolveInstanceSender, mas devolvendo tambem a instancia
// escolhida - para quem precisa saber qual numero foi de fato usado (ex.: o
// disparo imediato/teste, que grava o log so depois do envio e por isso nao
// tem um whatsapp_instance_id previo para gravar nele).
async function resolveInstance(whatsappInstanceId, options = {}) {
  const repository = options.whatsappInstancesRepository || defaultWhatsappInstancesRepository;

  // Distingue "nenhum numero cadastrado" de "todos os numeros pausados": so o
  // primeiro caso pode cair no sender historico do .env.
  async function hasAnyRegisteredInstance() {
    const listAll =
      typeof repository.listActive === "function"
        ? repository.listActive
        : repository.findAll;

    if (typeof listAll !== "function") {
      return false;
    }

    const all = await listAll.call(repository);

    return Boolean(all && all.length);
  }

  // O fallback pega a primeira instancia DISPONIVEL por prioridade: cair num
  // numero pausado aqui reintroduziria pela porta dos fundos justamente o envio
  // que a pausa deveria impedir.
  async function resolveDefaultActiveInstance() {
    const listDispatchable =
      typeof repository.listDispatchable === "function"
        ? repository.listDispatchable
        : repository.listActive;

    if (typeof listDispatchable !== "function") {
      return null;
    }

    const activeInstances = await listDispatchable.call(repository);

    return (activeInstances && activeInstances[0]) || null;
  }

  let instance = null;

  if (whatsappInstanceId) {
    instance = await repository.findById(whatsappInstanceId);

    // Instancia pinada no job mas pausada depois que ele foi agendado: os jobs
    // de uma campanha ja carregam o whatsapp_instance_id resolvido no momento
    // do agendamento, entao sem esta checagem uma pausa so valeria para
    // campanhas novas e os jobs ja na fila continuariam enviando pelo numero
    // pausado. Tratada como nao-resolvida, caindo no rodizio dos numeros
    // disponiveis logo abaixo.
    if (instance && instance.paused_at) {
      instance = null;
    }
  }

  if (!instance) {
    instance = await resolveDefaultActiveInstance();
  }

  if (!instance) {
    // Sem instancia disponivel ha dois casos bem diferentes, e o fallback
    // historico so vale para um deles.
    //
    // (a) Ha numeros cadastrados, mas TODOS estao pausados. Cair no
    //     sendToEvolution aqui enviaria pelo EVOLUTION_INSTANCE_NAME do .env,
    //     furando exatamente a pausa que o usuario pediu - e pior, em silencio.
    //     Entao falha explicitamente.
    //
    // (b) Nao ha nenhuma instancia cadastrada: instalacao que nunca migrou para
    //     a tabela whatsapp_instances. Mantem o comportamento historico.
    if (await hasAnyRegisteredInstance()) {
      const error = new Error("All WhatsApp instances are paused");
      error.code = "ALL_INSTANCES_PAUSED";
      throw error;
    }

    return { instance: null, sender: sendToEvolution };
  }

  const provider = new EvolutionDeliveryProvider({
    config: { ...evolutionConfig, instanceName: instance.instance_name },
  });

  return { instance, sender: (params) => provider.send(params) };
}

// Resolve o sender a ser usado em um envio: com whatsapp_instance_id valido,
// monta um EvolutionDeliveryProvider apontando para essa instancia; sem id
// (instalacoes com um unico numero, disparo de teste, ou compatibilidade
// retroativa) ou com um id que nao existe mais, cai para a PRIMEIRA instancia
// ativa por prioridade - nunca para o nome fixo em EVOLUTION_INSTANCE_NAME.
//
// Antes o fallback era `sendToEvolution` puro, que usa evolutionConfig.instanceName
// (o default do .env, historicamente "estimulo-mvp"). Assim que essa instancia
// era removida da Evolution (o caso normal ao trocar de numero), todo envio sem
// instance_id explicito - inclusive o botao "Enviar teste para este grupo" -
// quebrava com 404 "instance does not exist", mesmo havendo um numero
// perfeitamente configurado e conectado no banco.
//
// Vive fora de queues/dispatch.js porque o caminho de mensagem pontual
// agendada (queues/mensagens-dispatch.js) precisa da mesma resolucao, e
// importar dispatch.js de la arrastaria Google Drive e ffmpeg para dentro de um
// worker que so envia texto.
async function resolveInstanceSender(whatsappInstanceId, options = {}) {
  const { sender } = await resolveInstance(whatsappInstanceId, options);

  return sender;
}

module.exports = {
  resolveInstance,
  resolveInstanceSender,
};
