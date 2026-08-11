const { EvolutionDeliveryProvider, sendToEvolution } = require("./evolution");
const { evolutionConfig } = require("../config/evolution");
const defaultWhatsappInstancesRepository = require("../repositories/whatsapp-instances.repository");

// Resolve o sender a ser usado em um envio: sem whatsapp_instance_id
// (instalacoes com um unico numero, ou compatibilidade retroativa), usa o
// sender global padrao; com um id valido, monta um EvolutionDeliveryProvider
// apontando para a instancia especifica. Se a instancia nao existir mais,
// falha aberto para o sender padrao em vez de derrubar o job em andamento.
//
// Vive fora de queues/dispatch.js porque o caminho de mensagem pontual
// agendada (queues/mensagens-dispatch.js) precisa da mesma resolucao, e
// importar dispatch.js de la arrastaria Google Drive e ffmpeg para dentro de um
// worker que so envia texto.
async function resolveInstanceSender(whatsappInstanceId, options = {}) {
  const repository = options.whatsappInstancesRepository || defaultWhatsappInstancesRepository;

  if (!whatsappInstanceId) {
    return sendToEvolution;
  }

  const instance = await repository.findById(whatsappInstanceId);

  if (!instance) {
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
