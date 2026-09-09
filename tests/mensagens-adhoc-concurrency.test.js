const assert = require("node:assert/strict");

const { createMensagensService } = require("../src/services/mensagens.service");

/*
  Teto de envios simultaneos no disparo pontual sincrono.

  dispatchAdHoc usava `Promise.all` sobre a lista inteira de grupos. Dois
  problemas de uma vez, ambos so visiveis com dados reais:

    - MEMORIA: cada envio serializa a MESMA midia em base64 (ate ~136 MB por
      payload). Com 30 grupos, sao 30 serializacoes simultaneas do mesmo
      conteudo, num container sem limite de memoria declarado e com oito
      processos Node dividindo a RAM da VM.

    - ENTREGA: uma rajada de N mensagens simultaneas pelo mesmo numero e' o
      padrao que o WhatsApp trata como spam. O jitter existe no caminho de
      campanha exatamente para evitar isso; aqui nao havia teto nenhum.

  Os testes abaixo fixam o teto e a ordem do resultado (que precisa continuar
  casando com a ordem dos group_ids recebidos, porque a tela usa o indice).
*/

function buildHarness({ groupCount, concurrencyEnv }) {
  let emVoo = 0;
  let picoEmVoo = 0;
  const ordemDeEnvio = [];

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
      async update(id, payload) {
        return { id, ...payload };
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
      async createLog(payload) {
        return { id: `log-${payload.group_id}`, ...payload };
      },
      async updateStatus() {
        return {};
      },
      async updateProviderDelivery() {
        return {};
      },
    },
    whatsappInstancesRepository: {
      async listActive() {
        return [{ id: "instance-1", instance_name: "Numero A", priority: 0 }];
      },
    },
    whatsappInstancesService: {
      async listDispatchableInstances() {
        return [{ id: "instance-1", instance_name: "Numero A", priority: 0 }];
      },
      async filterDispatchableGroups(groupIds) {
        return { eligible: groupIds, ineligible: [] };
      },
      async getRotationSettings() {
        return { whatsapp_rotation_group_count: 1 };
      },
    },
    sendToEvolution: async (params) => {
      emVoo += 1;
      picoEmVoo = Math.max(picoEmVoo, emVoo);
      ordemDeEnvio.push(params.groupId);

      // Cede o event loop para que os envios realmente se sobreponham se o
      // codigo permitir - sem isto o teste passaria mesmo com Promise.all.
      await new Promise((resolve) => setTimeout(resolve, 5));

      emVoo -= 1;

      return { status: 201, data: { key: { id: "3EB0" }, status: "PENDING" } };
    },
    confirmProviderDelivery: async () => ({ confirmed: true }),
    settingsService: {
      async getSettings() {
        return { timezone: "America/Sao_Paulo" };
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  const groupIds = Array.from({ length: groupCount }, (_, index) => `group-${index}`);

  return { service, groupIds, stats: () => ({ picoEmVoo, ordemDeEnvio }) };
}

async function testRespeitaTetoPadrao() {
  delete process.env.ADHOC_DISPATCH_CONCURRENCY;

  const { service, groupIds, stats } = buildHarness({ groupCount: 20 });
  const result = await service.dispatchAdHoc({ group_ids: groupIds, texto: "oi" });

  assert.equal(result.enviados, 20, "todos os grupos precisam ser atendidos");
  assert.equal(result.falhas, 0);

  const { picoEmVoo } = stats();
  assert.equal(
    picoEmVoo <= 2,
    true,
    `com 20 grupos o pico de envios simultaneos foi ${picoEmVoo}; o teto padrao e 2 ` +
      "(antes, com Promise.all, seriam 20 requisicoes e 20 copias do payload ao mesmo tempo)"
  );
  // E precisa mesmo paralelizar ate o teto - serializar tudo dobraria a duracao
  // de um disparo grande sem necessidade.
  assert.equal(picoEmVoo, 2, "o teto e' um limite, nao uma serializacao total");
}

async function testTetoConfiguravel() {
  process.env.ADHOC_DISPATCH_CONCURRENCY = "5";

  try {
    const { service, groupIds, stats } = buildHarness({ groupCount: 20 });
    await service.dispatchAdHoc({ group_ids: groupIds, texto: "oi" });

    const { picoEmVoo } = stats();
    assert.equal(picoEmVoo, 5, `esperava pico 5 com ADHOC_DISPATCH_CONCURRENCY=5, veio ${picoEmVoo}`);
  } finally {
    delete process.env.ADHOC_DISPATCH_CONCURRENCY;
  }
}

async function testOrdemDoResultadoAcompanhaOsGrupos() {
  delete process.env.ADHOC_DISPATCH_CONCURRENCY;

  const { service, groupIds } = buildHarness({ groupCount: 7 });
  const result = await service.dispatchAdHoc({ group_ids: groupIds, texto: "oi" });

  // A tela casa results[i] com o grupo que o usuario escolheu; um pool que
  // devolvesse na ordem de conclusao trocaria os nomes na tela de resultado.
  assert.deepEqual(
    result.results.map((entry) => entry.group_id),
    groupIds,
    "a ordem do resultado precisa acompanhar a ordem dos group_ids recebidos"
  );
}

// Grupo invalido continua sendo falha DAQUELE grupo, nao da requisicao inteira -
// comportamento preservado da versao anterior, agora com log para o envio nao
// virar um "sumico" silencioso.
async function testGrupoInvalidoNaoDerrubaOLote() {
  delete process.env.ADHOC_DISPATCH_CONCURRENCY;

  const criados = [];
  const service = createMensagensService({
    groupsRepository: {
      async findById(id) {
        if (id === "group-ruim") {
          return { id, nome: "Sem JID", evolution_group_id: null, segmento: "aviso", organization_id: "org-1" };
        }
        return { id, nome: `Grupo ${id}`, evolution_group_id: `${id}@g.us`, segmento: "aviso", organization_id: "org-1" };
      },
    },
    campaignsRepository: {
      async create(payload) { return { id: "campaign-1", ...payload }; },
      async update(id, payload) { return { id, ...payload }; },
      async listActiveOverlappingWindow() { return []; },
    },
    campaignGroupsRepository: { async associateGroup() { return {}; }, async listGroups() { return []; } },
    dispatchLogsRepository: {
      async createLog(payload) {
        criados.push(payload);
        return { id: `log-${criados.length}`, ...payload };
      },
      async updateStatus() { return {}; },
      async updateProviderDelivery() { return {}; },
    },
    whatsappInstancesRepository: { async listActive() { return [{ id: "instance-1", priority: 0 }]; } },
    whatsappInstancesService: {
      async listDispatchableInstances() { return [{ id: "instance-1", priority: 0 }]; },
      async filterDispatchableGroups(ids) { return { eligible: ids, ineligible: [] }; },
      async getRotationSettings() { return { whatsapp_rotation_group_count: 1 }; },
    },
    sendToEvolution: async () => ({ status: 201, data: { key: { id: "3EB0" }, status: "PENDING" } }),
    confirmProviderDelivery: async () => ({ confirmed: true }),
    settingsService: { async getSettings() { return {}; } },
    logger: { info() {}, warn() {}, error() {} },
  });

  const result = await service.dispatchAdHoc({ group_ids: ["group-bom", "group-ruim"], texto: "oi" });

  assert.equal(result.enviados, 1);
  assert.equal(result.falhas, 1);
  assert.match(result.results[1].error, /evolution_group_id/);
  // O grupo invalido tambem ganha linha em `logs`: um envio recusado que nao
  // aparece no relatorio e' indistinguivel de um envio que nunca foi pedido.
  assert.equal(criados.length, 2, "os dois grupos precisam ter log, inclusive o invalido");
  assert.equal(criados[1].status, "falhou");
}

async function main() {
  await testRespeitaTetoPadrao();
  await testTetoConfiguravel();
  await testOrdemDoResultadoAcompanhaOsGrupos();
  await testGrupoInvalidoNaoDerrubaOLote();

  console.log("mensagens ad-hoc concurrency tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
