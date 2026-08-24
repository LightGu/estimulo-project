/*
  Regressao: dispatchAdHoc (o disparo IMEDIATO de mensagem pontual, usado pelo
  POST /mensagens/dispatch e pelo botao "Enviar teste para este grupo") chamava
  `sendToEvolution` direto, sem passar por resolveInstanceSender - diferente do
  caminho AGENDADO (mensagens-dispatch.js, via fila), que ja resolvia a
  instancia corretamente.

  `sendToEvolution` usa evolutionConfig.instanceName, um nome FIXO vindo do
  .env (historicamente "estimulo-mvp"). Ao remover essa instancia da Evolution
  (o caso normal ao trocar de numero), todo disparo imediato sem
  sendToEvolution injetado explicitamente quebrava com 404 "instance does not
  exist", mesmo com um numero configurado e conectado no banco - inclusive o
  botao de teste.

  Este teste fixa que, sem sendToEvolution nas dependencias, dispatchAdHoc
  passa pelo resolvedor de instancia (resolveInstanceSender) em vez de bater
  direto no sender fixo.
*/
const assert = require("node:assert/strict");

const { createMensagensService } = require("../src/services/mensagens.service");

function buildHarness(overrides = {}) {
  const resolveInstanceSenderCalls = [];
  const sentParams = [];

  const service = createMensagensService({
    groupsRepository: {
      async findById(id) {
        return {
          id,
          nome: `Grupo ${id}`,
          evolution_group_id: `${id}@g.us`,
          segmento: "aviso",
          organization_id: "org-1",
        };
      },
    },
    campaignsRepository: {
      async create(payload) {
        return { id: "campaign-1", ...payload };
      },
      async listActiveOverlappingWindow() {
        return [];
      },
    },
    campaignGroupsRepository: {
      async associateGroup() {
        return {};
      },
      async listGroups() {
        return [];
      },
    },
    dispatchLogsRepository: {
      async createLog() {
        return { id: "log-1" };
      },
      async updateProviderDelivery() {
        return {};
      },
    },
    whatsappInstancesRepository: {
      async listActive() {
        return overrides.instances || [];
      },
    },
    // Espiao no lugar do resolveInstanceSender real: prova que dispatchAdHoc
    // passa por ele, sem depender de rede nem do client HTTP da Evolution.
    resolveInstanceSender: async (whatsappInstanceId, options) => {
      resolveInstanceSenderCalls.push({ whatsappInstanceId, options });
      sentParams.length = 0;
      return async (params) => {
        sentParams.push(params);
        return { status: 201, data: { key: { id: "3EB0TEST" }, status: "PENDING" } };
      };
    },
    confirmProviderDelivery: async () => ({ confirmed: true }),
    logger: { info() {}, warn() {}, error() {} },
  });

  return { service, resolveInstanceSenderCalls, sentParams };
}

async function testDispatchAdHocPassaPeloResolvedorDeInstanciaSemSendToEvolutionInjetado() {
  const { service, resolveInstanceSenderCalls, sentParams } = buildHarness({
    instances: [{ id: "instance-1", instance_name: "TesteLucas", priority: 0 }],
  });

  const result = await service.dispatchAdHoc({ group_ids: ["group-1"], texto: "oi" });

  assert.equal(resolveInstanceSenderCalls.length, 1, "dispatchAdHoc precisa chamar resolveInstanceSender");
  // Sem instancia associada ao grupo (isso so existe na rotacao do envio
  // agendado), o disparo imediato deixa o resolvedor decidir - por isso undefined.
  assert.equal(resolveInstanceSenderCalls[0].whatsappInstanceId, undefined);
  assert.ok(
    resolveInstanceSenderCalls[0].options && resolveInstanceSenderCalls[0].options.whatsappInstancesRepository,
    "precisa passar o repositorio para o resolvedor poder consultar listActive()"
  );
  assert.equal(sentParams.length, 1, "o sender resolvido precisa ter sido efetivamente chamado");
  assert.equal(sentParams[0].groupId, "group-1@g.us");
  assert.equal(result.results[0].ok, true);
}

// dependencies.sendToEvolution continua tendo prioridade quando informado
// explicitamente (uso existente nos outros testes deste arquivo/projeto):
// nao pode passar pelo resolvedor.
async function testSendToEvolutionExplicitoIgnoraOResolvedor() {
  const explicitCalls = [];
  const resolveInstanceSenderCalls = [];

  const service = createMensagensService({
    groupsRepository: {
      async findById(id) {
        return { id, nome: `Grupo ${id}`, evolution_group_id: `${id}@g.us`, segmento: "aviso" };
      },
    },
    campaignsRepository: {
      async create(payload) {
        return { id: "campaign-1", ...payload };
      },
      async listActiveOverlappingWindow() {
        return [];
      },
    },
    campaignGroupsRepository: {
      async associateGroup() {
        return {};
      },
      async listGroups() {
        return [];
      },
    },
    dispatchLogsRepository: {
      async createLog() {
        return { id: "log-1" };
      },
      async updateProviderDelivery() {
        return {};
      },
    },
    whatsappInstancesRepository: { async listActive() { return []; } },
    resolveInstanceSender: async (...args) => {
      resolveInstanceSenderCalls.push(args);
      return async () => ({ status: 500 });
    },
    sendToEvolution: async (params) => {
      explicitCalls.push(params);
      return { status: 201, data: { key: { id: "3EB0TEST" }, status: "PENDING" } };
    },
    confirmProviderDelivery: async () => ({ confirmed: true }),
    logger: { info() {}, warn() {}, error() {} },
  });

  const result = await service.dispatchAdHoc({ group_ids: ["group-1"], texto: "oi" });

  assert.equal(explicitCalls.length, 1);
  assert.equal(resolveInstanceSenderCalls.length, 0, "com sendToEvolution explicito, o resolvedor nao deve ser chamado");
  assert.equal(result.results[0].ok, true);
}

async function main() {
  await testDispatchAdHocPassaPeloResolvedorDeInstanciaSemSendToEvolutionInjetado();
  await testSendToEvolutionExplicitoIgnoraOResolvedor();
  console.log("mensagens dispatch ad-hoc instance resolution tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
