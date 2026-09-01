/*
  "Failed to fetch" no botao "Enviar teste para este grupo".

  O botao usava POST /mensagens/dispatch (dispatchAdHoc), que segura a conexao
  HTTP ate a Evolution responder e o ACK ser confirmado. Com midia o teto e
  EVOLUTION_API_MEDIA_TIMEOUT_MS (180s por padrao); qualquer proxy/CDN na frente
  corta antes disso e o navegador entrega o erro nativo do fetch - as vezes com
  a mensagem ja entregue no grupo.

  dispatchAdHocAsync separa as duas fases: valida sincrono (para erro de
  verdade continuar chegando como 400/409 na tela) e joga so o envio na fila,
  com delay 0. Estes testes fixam:

    - dispatchAdHocAsync NAO chama a Evolution durante a requisicao;
    - o job entra com delay 0 (nada de jitter/janela num teste de um grupo);
    - a validacao continua sincrona e antes de qualquer efeito;
    - getDispatchStatus reporta pendente -> enviado/falhou a partir do log.
*/
const assert = require("node:assert/strict");

const { createMensagensService } = require("../src/services/mensagens.service");

function buildHarness(overrides = {}) {
  const enqueued = [];
  const createdCampaigns = [];
  const createdLogs = [];
  const sentParams = [];
  let logs = [];

  const service = createMensagensService({
    groupsRepository: {
      async findById(id) {
        if (overrides.groupById) {
          return overrides.groupById(id);
        }

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
        // Espelha a constraint CHECK de campaigns.status: um valor fora desta
        // lista passaria batido no mock e so estouraria 23514 em producao.
        const permitidos = ["gerando_legendas", "programado", "pausado", "cancelado", "concluido"];

        if (!permitidos.includes(payload.status)) {
          throw new Error(`campaigns.status invalido: ${payload.status}`);
        }

        createdCampaigns.push(payload);
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
      async createLog(payload) {
        const log = { id: `log-${createdLogs.length + 1}`, ...payload };
        createdLogs.push(log);
        logs.push(log);
        return log;
      },
      async listByCampaign() {
        return logs;
      },
      async updateProviderDelivery() {
        return {};
      },
    },
    whatsappInstancesRepository: {
      async listActive() {
        return [{ id: "instance-1", instance_name: "numero-1" }];
      },
      async listDispatchable() {
        return [{ id: "instance-1", instance_name: "numero-1" }];
      },
      async findById() {
        return { id: "instance-1", instance_name: "numero-1" };
      },
    },
    whatsappInstancesService: {
      async listDispatchableInstances() {
        return [{ id: "instance-1", instance_name: "numero-1" }];
      },
      async getRotationSettings() {
        return {};
      },
    },
    settingsService: {
      async getSettings() {
        return { timezone: "America/Sao_Paulo" };
      },
    },
    // Se o caminho assincrono chamar isto durante a requisicao, o teste falha:
    // e exatamente a espera que causava o "Failed to fetch".
    sendToEvolution: async (params) => {
      sentParams.push(params);
      return { ok: true };
    },
    addMensagensDispatchJob: async (params, options) => {
      enqueued.push({ params, options });
      return { id: `job-${enqueued.length}` };
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  return {
    service,
    enqueued,
    createdCampaigns,
    createdLogs,
    sentParams,
    setLogs(next) {
      logs = next;
    },
  };
}

async function testEnfileiraSemChamarEvolution() {
  const harness = buildHarness();

  const result = await harness.service.dispatchAdHocAsync({
    group_ids: ["grupo-teste"],
    texto: "mensagem de teste",
  });

  assert.equal(harness.sentParams.length, 0, "dispatchAdHocAsync nao pode chamar a Evolution na requisicao");
  assert.equal(harness.enqueued.length, 1, "deve enfileirar exatamente um job para um grupo");
  assert.equal(result.enfileirados, 1);
  assert.equal(result.campaign_id, "campaign-1");
  assert.ok(result.jobs[0].dispatch_log_id, "o job precisa carregar o dispatch_log_id para a tela acompanhar");
  assert.equal(
    harness.createdCampaigns[0].status,
    "programado",
    "a campanha ancora nasce programada: os jobs estao na fila, o envio ainda nao fechou"
  );
}

async function testJobSaiComDelayZero() {
  const harness = buildHarness();

  await harness.service.dispatchAdHocAsync({ group_ids: ["grupo-teste"], texto: "oi" });

  const [job] = harness.enqueued;
  assert.equal(job.options.delay, 0, "o teste tem que sair na hora - nada de jitter ou janela");
  assert.equal(job.params.group_id, "grupo-teste@g.us", "o worker envia pelo id da Evolution, nao pelo id interno");
  assert.equal(job.params.internal_group_id, "grupo-teste");
}

async function testLogNasceComoPendente() {
  const harness = buildHarness();

  await harness.service.dispatchAdHocAsync({ group_ids: ["grupo-teste"], texto: "oi" });

  assert.equal(harness.createdLogs.length, 1);
  assert.equal(harness.createdLogs[0].status, "pendente");
  assert.ok(
    harness.createdLogs[0].horario_envio_planejado,
    "sem horario planejado a trava de atraso do worker cancela o envio"
  );
}

async function testValidacaoContinuaSincrona() {
  const semGrupo = buildHarness();
  await assert.rejects(
    () => semGrupo.service.dispatchAdHocAsync({ group_ids: [], texto: "oi" }),
    /Selecione ao menos um grupo/
  );
  assert.equal(semGrupo.enqueued.length, 0);

  const semConteudo = buildHarness();
  await assert.rejects(
    () => semConteudo.service.dispatchAdHocAsync({ group_ids: ["g1"] }),
    /Informe um texto ou um link de conteudo/
  );
  assert.equal(semConteudo.enqueued.length, 0);

  const semEvolutionId = buildHarness({
    groupById: (id) => ({ id, nome: "Sem Evolution", evolution_group_id: null, segmento: "aviso" }),
  });
  await assert.rejects(
    () => semEvolutionId.service.dispatchAdHocAsync({ group_ids: ["g1"], texto: "oi" }),
    /sem evolution_group_id/
  );
  assert.equal(semEvolutionId.enqueued.length, 0, "grupo invalido nao pode gerar job");
}

async function testStatusRefleteOLog() {
  const harness = buildHarness();

  await harness.service.dispatchAdHocAsync({ group_ids: ["grupo-teste"], texto: "oi" });

  const pendente = await harness.service.getDispatchStatus("campaign-1");
  assert.equal(pendente.finalizado, false, "log pendente mantem a tela em polling");
  assert.equal(pendente.pendentes, 1);

  harness.setLogs([{ id: "log-1", group_id: "grupo-teste", status: "enviado", mensagem_erro: null }]);
  const enviado = await harness.service.getDispatchStatus("campaign-1");
  assert.equal(enviado.finalizado, true);
  assert.equal(enviado.enviados, 1);
  assert.equal(enviado.results[0].ok, true);
  assert.equal(enviado.results[0].group_nome, "Grupo grupo-teste", "a tela mostra o nome do grupo, nao o uuid");

  harness.setLogs([{ id: "log-1", group_id: "grupo-teste", status: "falhou", mensagem_erro: "instancia fora do ar" }]);
  const falhou = await harness.service.getDispatchStatus("campaign-1");
  assert.equal(falhou.finalizado, true, "falha tambem e estado final - nao pode deixar a tela em polling eterno");
  assert.equal(falhou.falhas, 1);
  assert.equal(falhou.results[0].ok, false);
  assert.equal(falhou.results[0].error, "instancia fora do ar");
}

async function main() {
  await testEnfileiraSemChamarEvolution();
  await testJobSaiComDelayZero();
  await testLogNasceComoPendente();
  await testValidacaoContinuaSincrona();
  await testStatusRefleteOLog();

  console.log("mensagens-async-test-dispatch: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
