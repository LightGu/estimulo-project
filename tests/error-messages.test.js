const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/*
  public/app/assets/js/error-messages.js roda no navegador e se expoe via
  window, sem module.exports. Aqui ele e' avaliado num contexto com um `window`
  falso, que e' o suficiente para testar a traducao (o arquivo nao toca em
  document nem em fetch no momento da carga).
*/
function loadErrorMessages() {
  const source = fs.readFileSync(
    path.join(__dirname, "../public/app/assets/js/error-messages.js"),
    "utf8"
  );
  // window.fetch e' o ponto de injecao: estimuloRequestJson chama por ele, e
  // nao pelo fetch global, justamente para o teste poder substituir.
  const windowStub = {};
  vm.runInNewContext(source, { window: windowStub });

  return windowStub;
}

async function main() {
  const windowStub = loadErrorMessages();
  const { estimuloTraduzirErro, estimuloErroEmLinha, estimuloRequestJson } = windowStub;

  assert.equal(typeof estimuloTraduzirErro, "function");
  assert.equal(typeof estimuloErroEmLinha, "function");
  assert.equal(typeof estimuloRequestJson, "function");

  // ---------- Falha de rede ----------
  // O caso que mais assusta o operador: "Failed to fetch" nao diz nada.
  {
    for (const mensagem of [
      "Failed to fetch",
      "NetworkError when attempting to fetch resource.",
      "Load failed",
    ]) {
      const t = estimuloTraduzirErro(new TypeError(mensagem));
      assert.equal(t.titulo, "Nao conseguimos falar com o servidor");
      assert.match(t.acao, /conexao/i);
      // A mensagem crua nao desaparece: vai para "Detalhes tecnicos".
      assert.equal(t.detalhe, mensagem);
      assert.ok(!/fetch/i.test(t.titulo + t.texto + t.acao), "jargao vazou para o texto do usuario");
    }

    // O erro marcado por estimuloRequestJson tambem cai na traducao de rede,
    // mesmo que a mensagem do browser mude.
    const marcado = new Error("qualquer coisa");
    marcado.isApiUnreachable = true;
    assert.equal(
      estimuloTraduzirErro(marcado).titulo,
      "Nao conseguimos falar com o servidor"
    );
  }

  // ---------- Erros de negocio traduzidos ----------
  {
    const casos = [
      ["Group has no trilha selected", /trilha do grupo/i],
      ["No approved video found for trail", /video aprovado/i],
      ["All WhatsApp instances are paused", /pausados/i],
      ["No active WhatsApp instances registered", /Nenhum numero/i],
      ["Existem legendas pendentes para esta campanha", /legendas/i],
      ["Resposta da Google Drive API nao contem bytes de video em formato suportado", /Formato de video/i],
      ["Extracao de audio gerou arquivo vazio (o video possui trilha de audio?)", /audio/i],
      ["Start date cannot be after end date", /datas/i],
    ];

    for (const [mensagem, esperado] of casos) {
      const erro = new Error(mensagem);
      erro.status = 400;
      const t = estimuloTraduzirErro(erro);
      assert.match(t.titulo, esperado, `titulo de "${mensagem}"`);
      assert.ok(t.acao, `"${mensagem}" precisa dizer o proximo passo`);
      // Nada do texto tecnico original pode sobrar na parte visivel.
      assert.notEqual(t.titulo, mensagem);
      assert.notEqual(t.texto, mensagem);
    }
  }

  // ---------- Campos obrigatorios e nao-encontrados ----------
  {
    const obrigatorio = estimuloTraduzirErro(Object.assign(new Error("Group name is required"), { status: 400 }));
    assert.match(obrigatorio.titulo, /Falta preencher: nome do grupo/);

    const naoAchou = estimuloTraduzirErro(Object.assign(new Error("Campaign not found"), { status: 404 }));
    assert.match(naoAchou.titulo, /Nao encontramos esse disparo/);
    assert.match(naoAchou.acao, /Recarregue/i);

    const duplicado = estimuloTraduzirErro(Object.assign(new Error("Group already exists"), { status: 409 }));
    assert.match(duplicado.titulo, /ja esta cadastrado/i);

    // "is required" nao catalogado ainda cai num texto util, nao no ingles cru.
    const generico = estimuloTraduzirErro(Object.assign(new Error("foo_bar is required"), { status: 400 }));
    assert.match(generico.titulo, /campo obrigatorio/i);
  }

  // ---------- Fallback por status ----------
  {
    // "Falha na requisicao (500)" nunca deve chegar ao usuario como texto.
    const semMensagem = Object.assign(new Error("Falha na requisicao (500)"), { status: 500 });
    const t = estimuloTraduzirErro(semMensagem);
    assert.match(t.titulo, /algo inesperado/i);
    assert.ok(!/Falha na requisicao/.test(t.texto));
    assert.match(t.detalhe, /Falha na requisicao \(500\)/);

    assert.match(estimuloTraduzirErro({ status: 401, message: "" }).titulo, /sessao expirou/i);
    assert.match(estimuloTraduzirErro({ status: 413, message: "" }).titulo, /grande demais/i);
    assert.match(estimuloTraduzirErro({ status: 429, message: "" }).titulo, /Muitas tentativas/i);
    assert.match(estimuloTraduzirErro({ status: 502, message: "" }).titulo, /servico externo/i);
  }

  // ---------- Mensagem tecnica nunca vira texto principal ----------
  {
    // Nome de coluna, tipo interno e contrato de modulo sao ilegiveis para o
    // operador: precisam do texto generico, com o cru apenas no detalhe.
    for (const mensagem of [
      "auto_send_after_timeout must be an object",
      "notification_group_id must be a string or null",
      "AIProviderAdapter invalido: generateCaption e obrigatorio",
      "videoCatalogRepository deve implementar findById(videoId) ou getById(videoId)",
    ]) {
      const t = estimuloTraduzirErro(Object.assign(new Error(mensagem), { status: 400 }));
      assert.notEqual(t.texto, mensagem, `"${mensagem}" nao deveria ser mostrado cru`);
      assert.equal(t.detalhe, mensagem);
    }

    // Ja uma mensagem em portugues escrita para o operador e' aproveitada.
    const legivel = "Este disparo já teve envios realizados e não pode ser apagado, para preservar o histórico.";
    const t = estimuloTraduzirErro(Object.assign(new Error(legivel), { status: 409 }));
    assert.match(t.titulo, /ja teve envios realizados/i);
  }

  // ---------- estimuloTraduzirErro aceita string ----------
  // Varias telas chamavam estimuloTratarErro(error.message); a traducao nao
  // pode quebrar quando recebe so a string.
  {
    const t = estimuloTraduzirErro("Group has no trilha selected");
    assert.match(t.titulo, /trilha do grupo/i);
  }

  // ---------- estimuloErroEmLinha ----------
  {
    const linha = estimuloErroEmLinha(Object.assign(new Error("All WhatsApp instances are paused"), { status: 400 }));
    assert.match(linha, /pausados/i);
    assert.match(linha, /Reative/i);
    assert.ok(!linha.includes("\n"), "texto inline precisa caber numa linha");
  }

  // ---------- estimuloRequestJson ----------
  {
    // Rejeicao do fetch (API fora do ar) precisa sair marcada.
    windowStub.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    await assert.rejects(
      () => estimuloRequestJson("/groups"),
      (erro) => {
        assert.equal(erro.isApiUnreachable, true);
        return true;
      }
    );

    // Resposta 4xx: status e payload precisam vir anexados.
    windowStub.fetch = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "Group has no trilha selected" }),
    });
    await assert.rejects(
      () => estimuloRequestJson("/groups"),
      (erro) => {
        assert.equal(erro.status, 400);
        assert.equal(erro.message, "Group has no trilha selected");
        assert.equal(erro.payload.error, "Group has no trilha selected");
        assert.notEqual(erro.isApiUnreachable, true);
        return true;
      }
    );

    // Corpo sem JSON valido num erro nao pode virar exception de parse.
    windowStub.fetch = async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    await assert.rejects(
      () => estimuloRequestJson("/groups"),
      (erro) => {
        assert.equal(erro.status, 500);
        assert.match(erro.message, /Falha na requisicao \(500\)/);
        return true;
      }
    );

    // Sucesso devolve o payload.
    windowStub.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: "grupo-1" }) });
    assert.deepEqual(await estimuloRequestJson("/groups"), { id: "grupo-1" });
  }

  console.log("error-messages.test.js OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
