const assert = require("node:assert/strict");

const dispatchLogsRepository = require("../src/repositories/dispatch-logs.repository");

/*
  createLog nao pode quebrar por causa de uma migration ainda nao aplicada.

  O PROBLEMA OPERACIONAL. O projeto nao tem CLI do Supabase linkado, e o playbook
  de deploy (CLAUDE.md) aplica migrations MANUALMENTE, no fim - depois de os
  containers novos ja estarem no ar. Ou seja: existe uma janela real em que o
  codigo novo roda contra o schema antigo.

  Se o INSERT de log carregasse uma coluna que ainda nao existe, o Postgrest
  recusaria a linha INTEIRA (PGRST204 / 42703) e nenhum envio conseguiria criar
  log - o que, com a ordem "registrar antes de enviar", significa nenhum envio
  acontecendo. Uma coluna de rastreabilidade derrubaria o disparo.

  Foi a mesma forma do incidente de organizations (migration 202608280001): a
  aplicacao mandava uma coluna que o banco real nao tinha e o PATCH inteiro
  voltava 500. Aqui a aposta e' maior, entao o codigo degrada: grava o log sem a
  coluna opcional e avisa uma vez por processo.

  Degradar so vale para colunas que NAO participam de decisao de envio -
  dispatch_ref e' correlacao de log. Erro de verdade (FK, check, not-null) tem de
  continuar subindo, senao esconderiamos corrupcao de dados.
*/

// Fake que recusa uma coluna do payload exatamente como o Postgrest recusa.
function createClientRejectingColumn(column, { code = "PGRST204" } = {}) {
  const inserts = [];

  return {
    inserts,
    from() {
      let payload = null;

      return {
        insert(next) {
          payload = next;
          return this;
        },
        select() {
          return this;
        },
        async single() {
          if (payload && Object.prototype.hasOwnProperty.call(payload, column)) {
            const error = new Error(`Could not find the '${column}' column of 'logs' in the schema cache`);
            error.code = code;
            return { data: null, error };
          }

          inserts.push(payload);
          return { data: { id: `log-${inserts.length}`, ...payload }, error: null };
        },
      };
    },
  };
}

function createClientFailingWith(error) {
  return {
    from() {
      return {
        insert() {
          return this;
        },
        select() {
          return this;
        },
        async single() {
          return { data: null, error };
        },
      };
    },
  };
}

const basePayload = {
  campaign_id: "11111111-1111-4111-8111-111111111111",
  group_id: "22222222-2222-4222-8222-222222222222",
  video_id: "33333333-3333-4333-8333-333333333333",
  status: "pendente",
  horario_envio_planejado: "2026-09-07T14:00:00.000Z",
  dispatch_ref: "d:11111111:22222222:33333333:1788789600000",
};

// (1) Coluna ausente com PGRST204: grava sem ela, preservando todo o resto.
async function testDegradaQuandoColunaNaoExiste() {
  const client = createClientRejectingColumn("dispatch_ref");

  const log = await dispatchLogsRepository.createLog({ ...basePayload }, client);

  assert.ok(log && log.id, "o log precisa ser criado mesmo sem a coluna");
  assert.equal(client.inserts.length, 1);
  assert.equal("dispatch_ref" in client.inserts[0], false, "a coluna inexistente e' removida do payload");
  // O que importa para o envio continua intacto.
  assert.equal(client.inserts[0].campaign_id, basePayload.campaign_id);
  assert.equal(client.inserts[0].status, "pendente");
  assert.equal(
    client.inserts[0].horario_envio_planejado,
    basePayload.horario_envio_planejado,
    "o horario planejado NAO pode ser descartado junto: e' o que ancora a trava de atraso"
  );
}

// (2) O Postgres cru devolve 42703 em vez de PGRST204 - os dois precisam ser
//     tratados, porque a mesma consulta pode chegar por caminhos diferentes.
async function testDegradaComCodigoDoPostgresCru() {
  const client = createClientRejectingColumn("dispatch_ref", { code: "42703" });

  const log = await dispatchLogsRepository.createLog({ ...basePayload }, client);

  assert.ok(log && log.id);
  assert.equal("dispatch_ref" in client.inserts[0], false);
}

// (3) Erro REAL continua subindo. Degradar aqui esconderia corrupcao: um
//     group_id inexistente tem de falhar, nao virar log silencioso.
async function testErroRealAindaPropaga() {
  const fkError = new Error('insert violates foreign key constraint "fk_logs_group"');
  fkError.code = "23503";

  await assert.rejects(
    () => dispatchLogsRepository.createLog({ ...basePayload }, createClientFailingWith(fkError)),
    /foreign key/,
    "violacao de FK nao pode ser degradada"
  );

  const checkError = new Error('violates check constraint "logs_status_check"');
  checkError.code = "23514";

  await assert.rejects(
    () => dispatchLogsRepository.createLog({ ...basePayload, status: "invalido" }, createClientFailingWith(checkError)),
    /check constraint/
  );
}

// (4) PGRST204 citando uma coluna que NAO esta na lista de opcionais tambem
//     precisa subir: nesse caso o payload esta errado de verdade (foi o
//     incidente de organizations), e engolir viraria gravacao silenciosamente
//     incompleta.
async function testColunaDesconhecidaNaoEhDegradada() {
  const error = new Error("Could not find the 'coluna_que_nao_deveria_existir' column of 'logs' in the schema cache");
  error.code = "PGRST204";

  await assert.rejects(
    () => dispatchLogsRepository.createLog({ ...basePayload }, createClientFailingWith(error)),
    /coluna_que_nao_deveria_existir/,
    "so colunas declaradas como opcionais podem ser descartadas"
  );
}

// (5) Sem a coluna problematica, o caminho normal nao ganha round-trip extra.
async function testCaminhoNormalNaoRegride() {
  const client = createClientRejectingColumn("coluna_inexistente_qualquer");

  const log = await dispatchLogsRepository.createLog({ ...basePayload }, client);

  assert.ok(log.id);
  assert.equal(client.inserts.length, 1, "uma unica tentativa quando nada e' recusado");
  assert.equal(client.inserts[0].dispatch_ref, basePayload.dispatch_ref, "com a coluna presente, o valor e' gravado");
}

async function main() {
  await testDegradaQuandoColunaNaoExiste();
  await testDegradaComCodigoDoPostgresCru();
  await testErroRealAindaPropaga();
  await testColunaDesconhecidaNaoEhDegradada();
  await testCaminhoNormalNaoRegride();

  console.log("dispatch-logs optional column tests OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
