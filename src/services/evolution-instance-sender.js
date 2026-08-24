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
async function resolveInstanceSender(whatsappInstanceId, options = {}) {
  const repository = options.whatsappInstancesRepository || defaultWhatsappInstancesRepository;

  async function resolveDefaultActiveInstance() {
    if (typeof repository.listActive !== "function") {
      return null;
    }

    const activeInstances = await repository.listActive();

    return (activeInstances && activeInstances[0]) || null;
  }

  let instance = null;

  if (whatsappInstanceId) {
    instance = await repository.findById(whatsappInstanceId);
  }

  if (!instance) {
    instance = await resolveDefaultActiveInstance();
  }

  if (!instance) {
    // Nenhuma instancia cadastrada no banco: ultimo recurso, mantem o
    // comportamento historico (evolutionConfig.instanceName) para nao quebrar
    // uma instalacao que nunca migrou para a tabela whatsapp_instances.
    return sendToEvolution;
  }

  const provider = new EvolutionDeliveryProvider({
    config: { ...evolutionConfig, instanceName: instance.instance_name },
  });

  return (params) => provider.send(params);
}

module.exports = {
  resolveInstanceSender,
};
