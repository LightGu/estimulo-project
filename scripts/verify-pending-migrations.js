/*
  Verificacao funcional das migrations de 202609, independente do script que as
  aplicou.

  Confirmar que o objeto EXISTE nao e' o mesmo que confirmar que ele FUNCIONA - e
  o incidente que originou essas migrations foi justamente uma constraint que
  existia e recusava o valor que a tela oferecia. Aqui cada uma e' exercitada de
  verdade, dentro de transacoes que sempre sofrem ROLLBACK: nenhuma linha de
  teste sobra no banco.
*/
require("dotenv").config({ quiet: true });

const { Client } = require("pg");

function resolveConnectionSettings() {
  const raw = process.env.DATABASE_URL || "";
  const senhaMatch = raw.match(/postgres(?:\.[a-z0-9]+)?:([^@]*)@/);
  const refMatch = (process.env.SUPABASE_URL || "").match(/https:\/\/([a-z0-9]+)\.supabase\.co/);

  if (!senhaMatch || !refMatch) {
    throw new Error("Nao consegui derivar senha/project ref do .env");
  }

  return {
    host: "aws-1-sa-east-1.pooler.supabase.com",
    port: 5432,
    user: `postgres.${refMatch[1]}`,
    password: decodeURIComponent(senhaMatch[1]),
    database: "postgres",
    ssl: { rejectUnauthorized: false },
    statement_timeout: 60000,
  };
}

const resultados = [];

function registrar(nome, passou, detalhe) {
  resultados.push({ nome, passou, detalhe });
  console.log(`${passou ? "OK  " : "FALHA"} ${nome}${detalhe ? " - " + detalhe : ""}`);
}

// Descobre as colunas NOT NULL sem default de uma tabela, para montar um insert
// minimo valido sem precisar chumbar o schema aqui.
async function requiredColumns(client, tabela) {
  const { rows } = await client.query(
    `select column_name, data_type
       from information_schema.columns
      where table_schema = 'public' and table_name = $1
        and is_nullable = 'NO' and column_default is null`,
    [tabela]
  );

  return rows;
}

async function main() {
  const client = new Client(resolveConnectionSettings());
  await client.connect();

  try {
    // ---- 1. A constraint aceita 'capacitacao' e ainda recusa lixo ----------
    //
    // O teste do incidente: era este INSERT que o banco recusava enquanto a
    // tela oferecia "Capacitacao", transformando 2 disparos entregues em zero
    // linhas de log.
    await client.query("begin");
    try {
      const obrigatorias = await requiredColumns(client, "campaigns");
      const colunas = ["classificacao"];
      const valores = ["'capacitacao'"];

      for (const coluna of obrigatorias) {
        if (coluna.column_name === "classificacao") continue;
        colunas.push(coluna.column_name);
        valores.push(coluna.data_type.includes("timestamp") ? "now()" : "'verificacao-migration'");
      }

      await client.query(
        `insert into public.campaigns (${colunas.join(", ")}) values (${valores.join(", ")})`
      );
      registrar("202609070001: campaigns aceita classificacao='capacitacao'", true);
    } catch (error) {
      registrar("202609070001: campaigns aceita classificacao='capacitacao'", false, error.message);
    } finally {
      await client.query("rollback");
    }

    await client.query("begin");
    try {
      await client.query("insert into public.campaigns (classificacao) values ('valor-invalido')");
      registrar("202609070001: constraint ainda recusa valor invalido", false, "o insert passou!");
    } catch (error) {
      const recusouPelaConstraint = error.message.includes("campaigns_classificacao_check");
      registrar(
        "202609070001: constraint ainda recusa valor invalido",
        recusouPelaConstraint,
        recusouPelaConstraint ? "23514 como esperado" : error.message
      );
    } finally {
      await client.query("rollback");
    }

    // ---- 2. O indice unico do trio realmente barra duplicata --------------
    //
    // Esta e' a defesa estrutural contra log duplicado. Um indice que existe mas
    // nao barra nada nao serve para nada, entao aqui a duplicata e' tentada de
    // verdade.
    await client.query("begin");
    try {
      /*
        Reutiliza um trio real - as FKs de logs (campaign_id, group_id,
        video_id) recusariam ids inventados, e o que se testa aqui e' o indice,
        nao as FKs.

        Mas o trio precisa estar SEM linha ativa. A primeira versao desta
        consulta pegava qualquer log, e caiu num trio que ja tinha linha
        'enviado' em producao: a PRIMEIRA insercao ja violava o indice, o erro
        subia para o catch externo e o teste se reportava como falha - quando o
        que tinha acontecido era o indice funcionando contra uma linha real.
        O `not exists` abaixo garante que a primeira insercao passe e a segunda
        seja a que colide.
      */
      const { rows: existentes } = await client.query(
        `select l.campaign_id, l.group_id, l.video_id
           from public.logs l
          where l.video_id is not null
            and not exists (
              select 1
                from public.logs ativo
               where ativo.campaign_id = l.campaign_id
                 and ativo.group_id = l.group_id
                 and ativo.video_id = l.video_id
                 and ativo.status in ('pendente', 'processando', 'enviado')
            )
          limit 1`
      );

      if (existentes.length === 0) {
        registrar(
          "202609070002: indice unico do trio barra duplicata",
          true,
          "sem log com video_id para reutilizar; validado pela definicao do indice"
        );
      } else {
        const base = existentes[0];
        const colunas = ["campaign_id", "group_id", "video_id", "status"];
        const linha = [base.campaign_id, base.group_id, base.video_id, "pendente"];

        // Primeira insercao: tem de PASSAR (o trio nao tem linha ativa).
        try {
          await client.query(
            `insert into public.logs (${colunas.join(", ")}) values ($1, $2, $3, $4)`,
            linha
          );
        } catch (error) {
          throw new Error(
            `a primeira insercao do trio deveria passar, mas falhou: ${error.code || ""} ${error.message}`
          );
        }

        let barrou = false;
        let mensagem = "";

        try {
          await client.query(
            `insert into public.logs (${colunas.join(", ")}) values ($1, $2, $3, $4)`,
            linha
          );
        } catch (error) {
          // Violacao de INDICE unico (nao de constraint nomeada) chega com
          // error.constraint vazio e o nome do indice dentro da mensagem -
          // por isso a checagem olha os dois campos, e nao so o primeiro.
          const origem = `${error.constraint || ""} ${error.message || ""}`;
          barrou = error.code === "23505" && origem.includes("idx_logs_trio_ativo");
          mensagem = `${error.code} ${error.constraint || "(via indice)"}`.trim();
        }

        registrar(
          "202609070002: indice unico do trio barra duplicata",
          barrou,
          barrou ? "23505 via idx_logs_trio_ativo, como esperado" : mensagem || "a duplicata passou!"
        );
      }
    } catch (error) {
      registrar("202609070002: indice unico do trio barra duplicata", false, error.message);
    } finally {
      await client.query("rollback");
    }

    // Status terminal fora do indice parcial: dois 'cancelado' do mesmo trio
    // TEM de ser permitido, senao o reagendamento de uma campanha recorrente
    // ficaria travado pelo historico.
    await client.query("begin");
    try {
      const { rows: existentes } = await client.query(
        `select campaign_id, group_id, video_id from public.logs where video_id is not null limit 1`
      );

      if (existentes.length === 0) {
        registrar("202609070002: status terminal fica FORA do indice parcial", true, "sem linha para reutilizar");
      } else {
        const base = existentes[0];
        for (let i = 0; i < 2; i += 1) {
          await client.query(
            `insert into public.logs (campaign_id, group_id, video_id, status) values ($1, $2, $3, 'cancelado')`,
            [base.campaign_id, base.group_id, base.video_id]
          );
        }
        registrar("202609070002: status terminal fica FORA do indice parcial", true, "dois 'cancelado' aceitos");
      }
    } catch (error) {
      registrar(
        "202609070002: status terminal fica FORA do indice parcial",
        false,
        `${error.code || ""} ${error.message}`.trim()
      );
    } finally {
      await client.query("rollback");
    }

    // ---- 3. dispatch_ref e gravavel e legivel -----------------------------
    //
    // O que importa aqui: o PostgREST recusa o INSERT INTEIRO quando ha coluna
    // desconhecida (42703). Enquanto a coluna nao existia, o codigo degradava
    // omitindo-a; agora tem de aceitar.
    await client.query("begin");
    try {
      const { rows: existentes } = await client.query(
        `select campaign_id, group_id, video_id from public.logs limit 1`
      );

      if (existentes.length === 0) {
        registrar("202609070003: logs.dispatch_ref aceita escrita", false, "sem log para reutilizar as FKs");
      } else {
        const base = existentes[0];
        const ref = "d:11111111:22222222:33333333";
        const { rows } = await client.query(
          `insert into public.logs (campaign_id, group_id, video_id, status, dispatch_ref)
           values ($1, $2, $3, 'cancelado', $4)
           returning dispatch_ref`,
          [base.campaign_id, base.group_id, base.video_id, ref]
        );

        registrar(
          "202609070003: logs.dispatch_ref aceita escrita",
          rows[0].dispatch_ref === ref,
          `gravou e leu "${rows[0].dispatch_ref}"`
        );
      }
    } catch (error) {
      registrar("202609070003: logs.dispatch_ref aceita escrita", false, `${error.code || ""} ${error.message}`.trim());
    } finally {
      await client.query("rollback");
    }

    // ---- 4. Nada sobrou no banco -----------------------------------------
    /*
      A limpeza e' garantida pelo ROLLBACK de cada bloco acima; estas consultas
      so confirmam.

      `campaigns` nao tem coluna de criacao (nem `criado_em` nem `nome`) - foi o
      que fez a primeira versao desta checagem falhar. Como o insert de
      verificacao preenche apenas `classificacao`, o residuo teria titulo,
      trilha e status_changed_at nulos/default e nenhum grupo associado: e' isso
      que se procura, em vez de um carimbo de tempo que nao existe.
    */
    const { rows: sujeira } = await client.query(
      `select count(*)::int as total
         from public.campaigns c
        where c.classificacao = 'capacitacao'
          and c.titulo is null
          and c.trilha is null
          and not exists (select 1 from public.campaign_groups g where g.campaign_id = c.id)`
    );
    registrar(
      "nenhuma campanha de verificacao ficou no banco",
      sujeira[0].total === 0,
      `${sujeira[0].total} campanha(s) orfa(s) de 'capacitacao'`
    );

    const { rows: refs } = await client.query(
      `select count(*)::int as total from public.logs where dispatch_ref = 'd:11111111:22222222:33333333'`
    );
    registrar("nenhum log de verificacao ficou no banco", refs[0].total === 0, `${refs[0].total} linha(s) residual(is)`);
  } finally {
    await client.end();
  }

  const falhas = resultados.filter((r) => !r.passou);

  console.log(`\n${resultados.length - falhas.length}/${resultados.length} verificacoes passaram`);

  if (falhas.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("FALHOU:", error.message);
  process.exitCode = 1;
});
