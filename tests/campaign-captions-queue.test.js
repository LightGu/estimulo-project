const assert = require("node:assert/strict");

const {
  buildCampaignCaptionsJobData,
  buildCampaignCaptionsJobId,
  createCampaignCaptionsProcessor,
} = require("../src/queues/campaign-captions");
const { createCampaignVideoCaptionsService } = require("../src/services/campaign-video-captions.service");
const { closeQueueInfrastructure } = require("../src/queues/bullmq");

/*
  A geracao de legendas era uma promise solta no processo da API:

    generateCaptionsForCampaign(id).then(() => maybeAutoConfirmDispatch(...))
                                   .catch(console.error)

  A campanha nascia em "gerando_legendas" e SO aquela promise podia tira-la de
  la. Todo deploy recria o container da api, entao uma geracao em andamento era
  abandonada e a campanha ficava presa naquele status para sempre - sem retry,
  sem estado de onde retomar, e com o erro apenas num console.error.

  Estes testes cobrem as propriedades que a fila precisa ter para valer a
  substituicao. A que mais importa e' a retomada: sem ela, o retry causaria dano
  em vez de resolver, porque createManyPending e' um upsert que devolve a linha
  para "pendente".
*/

function buildJob(data, overrides = {}) {
  return {
    id: "job-1",
    data: buildCampaignCaptionsJobData(data),
    attemptsMade: 0,
    opts: { attempts: 3 },
    ...overrides,
  };
}

const logger = { info() {}, warn() {}, error() {} };

// 1. UMA GERACAO POR CAMPANHA. O jobId deterministico e' a protecao contra dois
//    lacos concorrentes sobre as MESMAS linhas (dois cliques em "Disparar", ou
//    um retry da tela) - a BullMQ recusa em silencio um add() com id repetido.
function testJobIdEhDeterministicoPorCampanha() {
  const campaignId = "11111111-1111-4111-8111-111111111111";

  assert.equal(buildCampaignCaptionsJobId(campaignId), buildCampaignCaptionsJobId(campaignId));
  assert.notEqual(buildCampaignCaptionsJobId(campaignId), buildCampaignCaptionsJobId("outra"));
  // A BullMQ so aceita ":" num jobId customizado quando o resultado tem
  // exatamente 3 segmentos (formato reservado de repeatable job); qualquer ":"
  // no id da campanha faria o add() ser recusado.
  assert.equal(buildCampaignCaptionsJobId("a:b:c").includes(":"), false);
}

// 2. CAMPANHA CANCELADA NA ESPERA NAO GERA LEGENDA. O job pode ficar minutos na
//    fila; gerar legenda para campanha cancelada e' consumo de cota do Gemini
//    para jogar fora.
async function testNaoGeraQuandoCampanhaFoiCancelada() {
  let geracoes = 0;

  const processor = createCampaignCaptionsProcessor({
    logger,
    campaignsRepository: {
      async findById() {
        return { id: "campaign-1", status: "cancelado" };
      },
    },
    campaignVideoCaptionsService: {
      async generateCaptionsForCampaign() {
        geracoes += 1;
        return { progress: { total: 1, gerado: 1, erro: 0, pendente: 0 } };
      },
    },
    settingsService: { async getDispatchRulesSettings() { return {}; } },
    inAppNotificationsService: {},
  });

  const result = await processor(buildJob({ campaign_id: "campaign-1" }));

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "status_cancelado");
  assert.equal(geracoes, 0, "campanha cancelada nao pode consumir cota de legenda");
}

// 3. CAMPANHA APAGADA NAO VIRA TRES TENTATIVAS. Sem esta saida, o job retentaria
//    (com backoff de 1 min) contra uma linha que nao existe.
async function testCampanhaInexistenteNaoRetenta() {
  const processor = createCampaignCaptionsProcessor({
    logger,
    campaignsRepository: { async findById() { return null; } },
    campaignVideoCaptionsService: {
      async generateCaptionsForCampaign() {
        throw new Error("nao deveria ser chamado");
      },
    },
    settingsService: { async getDispatchRulesSettings() { return {}; } },
    inAppNotificationsService: {},
  });

  const result = await processor(buildJob({ campaign_id: "campaign-fantasma" }));

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "campanha_inexistente");
}

// 4. CONFIRMACAO AUTOMATICA SO COM require_human_review === false, e falha
//    fechado quando a regra nao pode ser lida - nao saber se precisa de revisao
//    humana nao autoriza enviar sem revisao.
async function testAutoConfirmacaoRespeitaARegra() {
  function build({ dispatchRules, dispatchRulesError }) {
    const confirmadas = [];

    const processor = createCampaignCaptionsProcessor({
      logger,
      campaignsRepository: {
        async findById() {
          return { id: "campaign-1", status: "gerando_legendas" };
        },
      },
      campaignVideoCaptionsService: {
        async generateCaptionsForCampaign() {
          return { progress: { total: 2, gerado: 2, erro: 0, pendente: 0 } };
        },
      },
      settingsService: {
        async getDispatchRulesSettings() {
          if (dispatchRulesError) {
            throw new Error("settings fora do ar");
          }

          return dispatchRules;
        },
      },
      inAppNotificationsService: {},
      resolveCampaignsService: () => ({
        async confirmDispatch(campaignId, payload) {
          confirmadas.push({ campaignId, payload });
        },
      }),
    });

    return { processor, confirmadas };
  }

  const semRevisao = build({ dispatchRules: { require_human_review: false } });
  let result = await semRevisao.processor(
    buildJob({ campaign_id: "campaign-1", confirm_payload: { execution_at: "2026-09-08T12:00:00.000Z" } })
  );
  assert.equal(result.auto_confirm, "done");
  assert.equal(semRevisao.confirmadas.length, 1);
  assert.deepEqual(semRevisao.confirmadas[0].payload, { execution_at: "2026-09-08T12:00:00.000Z" });

  const comRevisao = build({ dispatchRules: { require_human_review: true } });
  result = await comRevisao.processor(buildJob({ campaign_id: "campaign-1", confirm_payload: {} }));
  assert.equal(result.auto_confirm, "skipped");
  assert.equal(comRevisao.confirmadas.length, 0);

  const semSettings = build({ dispatchRulesError: true });
  result = await semSettings.processor(buildJob({ campaign_id: "campaign-1", confirm_payload: {} }));
  assert.equal(result.auto_confirm, "skipped");
  assert.equal(semSettings.confirmadas.length, 0, "falha ao ler a regra nao pode virar envio sem revisao");
}

// 5. FALHA NA CONFIRMACAO NAO REGERA AS LEGENDAS. A geracao terminou; relancar
//    aqui faria o job retentar e gastar a cota do Gemini de novo por causa de um
//    problema que e' da confirmacao.
async function testFalhaNaConfirmacaoNaoDerrubaAGeracao() {
  let geracoes = 0;

  const processor = createCampaignCaptionsProcessor({
    logger,
    campaignsRepository: {
      async findById() {
        return { id: "campaign-1", status: "gerando_legendas" };
      },
    },
    campaignVideoCaptionsService: {
      async generateCaptionsForCampaign() {
        geracoes += 1;
        return { progress: { total: 1, gerado: 1, erro: 0, pendente: 0 } };
      },
    },
    settingsService: { async getDispatchRulesSettings() { return { require_human_review: false }; } },
    inAppNotificationsService: {},
    resolveCampaignsService: () => ({
      async confirmDispatch() {
        throw new Error("janela de envio conflita com outra campanha");
      },
    }),
  });

  const result = await processor(buildJob({ campaign_id: "campaign-1", confirm_payload: {} }));

  assert.equal(result.status, "completed");
  assert.equal(result.auto_confirm, "failed");
  assert.equal(geracoes, 1);
}

// 6. LEGENDA EM ERRO NAO REGERA A CAMPANHA INTEIRA. Um video problematico
//    (transcricao vazia, cota estourada naquele item) fica registrado como
//    "erro" na Etapa 2 e espera acao humana; retentar tudo desperdicaria cota
//    nos videos que ja deram certo.
async function testItemEmErroNaoRelancaOJob() {
  const processor = createCampaignCaptionsProcessor({
    logger,
    campaignsRepository: {
      async findById() {
        return { id: "campaign-1", status: "gerando_legendas" };
      },
    },
    campaignVideoCaptionsService: {
      async generateCaptionsForCampaign() {
        return { progress: { total: 3, gerado: 2, erro: 1, pendente: 1 } };
      },
    },
    settingsService: { async getDispatchRulesSettings() { return {}; } },
    inAppNotificationsService: {},
  });

  const result = await processor(buildJob({ campaign_id: "campaign-1" }));

  assert.equal(result.status, "partial");
}

// 7. GERACAO INCOMPLETA SEM ERRO RELANCA. Linha que ficou "pendente" sem virar
//    erro e' interrupcao no meio do laco - o caso que a fila existe para
//    resolver, e o unico em que retentar ajuda.
async function testGeracaoIncompletaRelanca() {
  let notificacoes = 0;

  const processor = createCampaignCaptionsProcessor({
    logger,
    campaignsRepository: {
      async findById() {
        return { id: "campaign-1", status: "gerando_legendas", nome: "Campanha 08/09" };
      },
    },
    campaignVideoCaptionsService: {
      async generateCaptionsForCampaign() {
        return { progress: { total: 3, gerado: 1, erro: 0, pendente: 2 } };
      },
    },
    settingsService: { async getDispatchRulesSettings() { return {}; } },
    inAppNotificationsService: {
      async notifyCampaignStuckGeneratingCaptions() {
        notificacoes += 1;
      },
    },
  });

  await assert.rejects(
    () => processor(buildJob({ campaign_id: "campaign-1" })),
    /terminou incompleta/
  );
  assert.equal(notificacoes, 0, "tentativa intermediaria nao deve notificar");

  // Ultima tentativa: a campanha vai ficar presa em "gerando_legendas" sem nada
  // que a tire de la. E' o estado que antes acontecia em silencio, entao aqui
  // precisa gerar aviso na tela.
  await assert.rejects(
    () => processor(buildJob({ campaign_id: "campaign-1" }, { attemptsMade: 2 })),
    /terminou incompleta/
  );
  assert.equal(notificacoes, 1, "a ultima tentativa precisa avisar que a campanha ficou presa");
}

// 8. O WORKER PEDE RETOMADA. E' a propriedade que torna o retry seguro; sem o
//    `resume`, a segunda tentativa devolveria as legendas prontas para
//    "pendente" e as geraria de novo.
async function testWorkerPedeRetomada() {
  const chamadas = [];

  const processor = createCampaignCaptionsProcessor({
    logger,
    campaignsRepository: {
      async findById() {
        return { id: "campaign-1", status: "gerando_legendas" };
      },
    },
    campaignVideoCaptionsService: {
      async generateCaptionsForCampaign(campaignId, options) {
        chamadas.push({ campaignId, options });
        return { progress: { total: 1, gerado: 1, erro: 0, pendente: 0 } };
      },
    },
    settingsService: { async getDispatchRulesSettings() { return {}; } },
    inAppNotificationsService: {},
  });

  await processor(buildJob({ campaign_id: "campaign-1" }));

  assert.deepEqual(chamadas, [{ campaignId: "campaign-1", options: { resume: true } }]);
}

/*
  9. A RETOMADA DE VERDADE, no service.

  Este e' o teste que justifica o retry existir. Antes, uma segunda rodada
  passava TODOS os grupos por createManyPending - um upsert com
  `status: "pendente", erro_mensagem: null` -, o que:

    - devolvia para a fila legendas que ja estavam "gerado";
    - gastava a cota do Gemini de novo sobre os mesmos videos;
    - descartava texto que o usuario tivesse editado a mao na Etapa 2.

  Com `{ resume: true }`, so o que nao esta "gerado" volta para a fila.
*/
async function testRetomadaPreservaLegendasJaGeradas() {
  const linhasExistentes = [
    // Ja pronta, e com texto que o usuario editou a mao na Etapa 2.
    {
      id: "row-1",
      campaign_id: "campaign-1",
      group_id: "group-1",
      video_id: "video-1",
      status: "gerado",
      caption_id: "caption-ja-usada",
      legenda: "texto revisado a mao",
    },
    // Falhou: e' o que a retentativa existe para consertar.
    { id: "row-2", campaign_id: "campaign-1", group_id: "group-2", video_id: "video-1", status: "erro", caption_id: null },
    // Interrompida no meio (o deploy que derrubou o processo): sem resultado
    // para aproveitar, volta para a fila.
    { id: "row-3", campaign_id: "campaign-1", group_id: "group-3", video_id: "video-1", status: "processando", caption_id: null },
  ];

  function buildService() {
    const upsertados = [];
    const marcadosProcessando = [];
    const excludeCaptionIdsVistos = [];

    const service = createCampaignVideoCaptionsService({
      logger,
      repository: {
        async listByCampaign() {
          return linhasExistentes;
        },
        async createManyPending(payloads) {
          upsertados.push(...payloads.map((payload) => payload.group_id));

          return payloads.map((payload, index) => ({ id: `novo-${index}`, ...payload, status: "pendente" }));
        },
        async markProcessing(id) {
          marcadosProcessando.push(id);

          return { id };
        },
        async markGenerated(id, generated) {
          return { id, status: "gerado", ...generated };
        },
        async markError(id, payload) {
          return { id, status: "erro", ...payload };
        },
      },
      campaigns: {
        async findById() {
          return { id: "campaign-1", status: "gerando_legendas" };
        },
        async update() {
          return {};
        },
      },
      campaignGroups: {
        async listGroups() {
          return [
            { groups: { id: "group-1", envia_video: true, evolution_group_id: "group-1@g.us" } },
            { groups: { id: "group-2", envia_video: true, evolution_group_id: "group-2@g.us" } },
            { groups: { id: "group-3", envia_video: true, evolution_group_id: "group-3@g.us" } },
          ];
        },
      },
      videoFlowRepository: {
        async findNextApprovedUnsentVideoForGroup() {
          return { id: "video-1" };
        },
      },
      groupVideoProgressRepository: { async listDelivered() { return []; } },
      settingsService: { async getDispatchRulesSettings() { return { auto_generate_caption: true }; } },
      videoCaptionsService: {
        async selectCaptionForVideo(videoId, options = {}) {
          excludeCaptionIdsVistos.push([...(options.excludeCaptionIds || [])]);

          return { id: "caption-nova", text: "legenda nova" };
        },
      },
      captionReviewService: { async assertCaptionApproved() { return { approved: true }; } },
      videoCatalogRepository: { async findById() { return { id: "video-1", transcricao: "transcricao pronta" }; } },
      notificationsService: { async notifyAiError() { return { sent: true }; } },
    });

    return { service, upsertados, marcadosProcessando, excludeCaptionIdsVistos };
  }

  // Sem retomada (comportamento da chamada direta, preservado): os TRES grupos
  // voltam para "pendente" - inclusive o que ja estava gerado.
  const semRetomada = buildService();
  await semRetomada.service.generateCaptionsForCampaign("campaign-1");

  assert.deepEqual(
    semRetomada.upsertados.sort(),
    ["group-1", "group-2", "group-3"],
    "sem resume, o upsert devolve a campanha inteira para pendente (comportamento antigo)"
  );

  // Com retomada: a linha "gerado" nao e' tocada.
  const comRetomada = buildService();
  const resultado = await comRetomada.service.generateCaptionsForCampaign("campaign-1", { resume: true });

  assert.deepEqual(
    comRetomada.upsertados.sort(),
    ["group-2", "group-3"],
    "a legenda ja gerada nao pode voltar para a fila: o upsert de createManyPending " +
      "grava status pendente e apagaria o texto revisado a mao"
  );
  assert.equal(
    comRetomada.marcadosProcessando.includes("row-1"),
    false,
    "a linha preservada nao deve ser regerada"
  );

  // A linha preservada continua no resultado, na sua posicao - a tela da Etapa 2
  // conta o retorno por grupo.
  assert.equal(resultado.generated.length, 3);
  assert.equal(resultado.generated[0].id, "row-1");
  assert.equal(resultado.generated[0].legenda, "texto revisado a mao");

  // E o caption_id da legenda preservada continua reservado: sem isto, a
  // retomada poderia sortear para group-2 exatamente a legenda que group-1 ja
  // recebeu na primeira rodada.
  assert.ok(
    comRetomada.excludeCaptionIdsVistos.length > 0,
    "a geracao dos grupos restantes deveria ter consultado selectCaptionForVideo"
  );
  assert.ok(
    comRetomada.excludeCaptionIdsVistos[0].includes("caption-ja-usada"),
    `esperava caption-ja-usada entre os excluidos, veio ${JSON.stringify(comRetomada.excludeCaptionIdsVistos[0])}`
  );
}

async function main() {
  testJobIdEhDeterministicoPorCampanha();
  await testNaoGeraQuandoCampanhaFoiCancelada();
  await testCampanhaInexistenteNaoRetenta();
  await testAutoConfirmacaoRespeitaARegra();
  await testFalhaNaConfirmacaoNaoDerrubaAGeracao();
  await testItemEmErroNaoRelancaOJob();
  await testGeracaoIncompletaRelanca();
  await testWorkerPedeRetomada();
  await testRetomadaPreservaLegendasJaGeradas();

  console.log("campaign-captions queue tests OK");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    closeQueueInfrastructure();
  });
