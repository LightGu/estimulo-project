# Migrations da auditoria de 07/09/2026 — **APLICADAS**

> **Status: as três foram aplicadas em produção em 07/09/2026 e verificadas.**
>
> Aplicadas por `scripts/apply-pending-migrations.js --apply`, com autorização
> explícita do usuário (a rota padrão do projeto continua sendo colar no SQL
> Editor — este documento fica como registro do que foi feito e por quê).
>
> Estado confirmado depois:
> - `campaigns_classificacao_check` aceita `capacitacao` (e ainda recusa valor inválido)
> - `logs.dispatch_ref` existe, gravável e visível ao PostgREST
> - `idx_logs_trio_ativo` e `idx_logs_campaign_group_video_status` criados e **válidos**
> - zero trios duplicados antes e depois
>
> Verificado por três caminhos independentes:
> - `scripts/apply-pending-migrations.js --check` — inspeção do catálogo
> - `scripts/verify-pending-migrations.js` — **7/7**, exercitando cada objeto de
>   verdade (insert que o incidente recusava, duplicata que o índice tem de
>   barrar, status terminal que ele tem de deixar passar), tudo em transações com
>   `ROLLBACK`
> - `scripts/verify-postgrest-schema.js` — pelo **PostgREST**, que é o caminho que
>   a aplicação usa. Importa porque o PostgREST tem cache de schema próprio: uma
>   coluna que existe no Postgres mas não no cache dele ainda responde `42703`, que
>   era justamente o erro que derrubava o INSERT inteiro de `logs`.
>
> Consequência prática: a degradação de `createLog` para coluna opcional ausente
> não é mais exercida em produção — mas fica no código, porque é ela que protege a
> janela de deploy da próxima coluna nova.


Três migrations novas, para colar no **SQL Editor do Supabase** (o projeto não tem
CLI linkado). Verificado em 07/09/2026 que todas as migrations anteriores a estas
já estão aplicadas no banco de produção.

**A ordem importa**, e a 2ª pode falhar por dados pré-existentes. Leia a seção de
cada uma antes de rodar.

---

## Ordem de deploy — o que foi feito

O código foi escrito para tolerar as migrations **ainda não aplicadas**, então
qualquer ordem funcionaria sem derrubar o disparo. A ordem usada foi a ideal:

1. ~~Aplicar **202609070001** (constraint de classificação)~~ — **feito**, antes do
   deploy do código. Era a única que corrigia uma perda de dados já em curso, e não
   dependia de código novo.
2. Deploy do código — **pendente** (o código está na árvore, não commitado).
3. ~~Aplicar **202609070002** e **202609070003**~~ — **feito**, na mesma execução.

Como as três já estão no banco, o deploy do código não tem mais janela de risco
nenhuma: `dispatch_ref` já existe quando os containers novos subirem.

### Passo extra neste deploy: container novo

Este deploy adiciona um worker, `campaign-captions-worker` — a geração de legendas
saiu do processo da API e virou fila (ver `docs/filas.md`). Ele **já está** na lista
de build/up do playbook de deploy, mas confira que subiu:

```bash
docker compose --env-file ../.env ps --format 'table {{.Name}}	{{.Status}}' | grep captions
```

Se ele não estiver de pé, campanhas de vídeo despachadas ficam paradas em
`gerando_legendas` — o mesmo sintoma de antes, agora com a diferença de que o job
espera no Redis e é processado quando o worker sobe (nada se perde).

Nenhuma migration nova é necessária para o worker nem para o depósito de anexo:
a fila vive no Redis e o depósito também. `notifications.type` é `text` sem
CHECK, então a notificação de campanha travada não precisa de DDL — isso foi
verificado no banco de produção em 07/09/2026.

Por que o código tolera a ausência: `createLog` degrada quando uma coluna
opcional (hoje só `dispatch_ref`) não existe — grava a linha sem ela e registra
`dispatch_logs.optional_column_missing` uma vez por processo. Sem essa
tolerância, a janela entre "containers novos no ar" e "SQL colado" seria uma
interrupção total de envios, porque o PostgREST recusa o INSERT inteiro por causa
de uma coluna desconhecida. Ver `tests/dispatch-logs-optional-column.test.js`.

---

## 1. `202609070001_fix_campaigns_classificacao_capacitacao.sql`

**Corrige perda de registro já observada em produção.** Aplique primeiro.

A tela do Disparador Pontual oferece "Capacitação", o service aceita
`capacitacao`, e a constraint só permitia
`('evento','credito','pesquisa','aviso','outro')`. Como o envio acontecia **antes**
de a campanha âncora ser gravada, o INSERT recusado não virava erro na tela:
virava mensagens entregues nos grupos com **zero linhas em `logs`**.

Aconteceu duas vezes, com evidência no log de produção:

```
2026-09-04T21:13:35Z {"event":"mensagens.persist_ad_hoc_campaign_failed",
  "error_message":"new row for relation \"campaigns\" violates check constraint
                   \"campaigns_classificacao_check\""}
2026-09-04T21:45:40Z {"event":"mensagens.persist_ad_hoc_campaign_failed", ...}
```

Esses dois disparos existiram no WhatsApp e nunca existiram no relatório. **Não há
como recuperá-los** — o log não registra quais grupos receberam (o `catch` só
gravava a mensagem de erro). Se for importante saber, o histórico dos próprios
grupos no WhatsApp é a única fonte.

```sql
DO $$
BEGIN
    ALTER TABLE public.campaigns
        DROP CONSTRAINT IF EXISTS campaigns_classificacao_check;

    ALTER TABLE public.campaigns
        ADD CONSTRAINT campaigns_classificacao_check
        CHECK (classificacao IN ('evento', 'credito', 'pesquisa', 'aviso', 'capacitacao', 'outro'));
END $$;
```

Depois disso, `tests/mensagens-classificacao-schema-contract.test.js` trava as três
camadas (banco, service, tela) juntas, para que a próxima classificação nova não
repita o incidente.

---

## 2. `202609070002_add_logs_trio_unique_index.sql`

**Esta pode falhar** se já existirem duplicatas. Rode o diagnóstico primeiro:

```sql
SELECT campaign_id, group_id, video_id, count(*) AS linhas,
       array_agg(id ORDER BY criado_em) AS log_ids,
       array_agg(status ORDER BY criado_em) AS status
  FROM public.logs
 WHERE status IN ('pendente','processando','enviado')
 GROUP BY 1,2,3
HAVING count(*) > 1;
```

Verificado em 07/09/2026: **413 logs no total, 0 em `pendente` e 0 em
`processando`** (309 enviado, 12 falhou, 92 cancelado). Ou seja, o passivo de
duplicatas/órfãos está limpo e o índice deve criar sem conflito — mas confirme,
porque o estado pode ter mudado.

Se aparecer duplicata: preserve a linha `enviado` (ou a mais recente) e marque as
outras como `cancelado`, com `cancelado_origem='sistema'` e uma `mensagem_erro`
dizendo que era duplicata de corrida. Preserva o histórico e não inventa entrega
que não houve.

```sql
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_logs_trio_ativo
    ON public.logs (campaign_id, group_id, video_id)
    WHERE status IN ('pendente', 'processando', 'enviado');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_logs_campaign_group_video_status
    ON public.logs (campaign_id, group_id, video_id, status);
```

`CONCURRENTLY` não roda dentro de bloco transacional — cole **um statement por
vez** no SQL Editor.

Este índice é o que finalmente libera `--scale dispatch-worker=N` / `concurrency > 1`,
que estavam bloqueados pela corrida do trio.

---

## 3. `202609070003_add_logs_dispatch_ref.sql`

Coluna de correlação. Sem ela o sistema funciona igual, só sem a chave única de
rastreio nos logs (e com o aviso `optional_column_missing` no stdout dos workers).

```sql
ALTER TABLE public.logs
    ADD COLUMN IF NOT EXISTS dispatch_ref text;

CREATE INDEX IF NOT EXISTS idx_logs_dispatch_ref
    ON public.logs (dispatch_ref)
    WHERE dispatch_ref IS NOT NULL;

COMMENT ON COLUMN public.logs.dispatch_ref IS
    'Identificador de correlacao do envio, deterministico, propagado ate os logs '
    'estruturados dos workers e as tags do Sentry. Ver src/utils/dispatch-ref.js.';
```

Logs anteriores ficam com `dispatch_ref` nulo — é esperado, o valor é
determinístico mas não há como recalculá-lo em massa sem o `horario_envio_planejado`
exato de cada linha (e várias linhas antigas o têm nulo, justamente o problema dos
"logs órfãos").

---

## Mudança de ambiente que acompanha este deploy

`infra/docker-compose.yml` passou a injetar duas variáveis no bloco `x-app`:

```yaml
EVOLUTION_DB_HOST: ${EVOLUTION_DB_HOST_INTERNAL:-evolution-postgres}
EVOLUTION_DB_PORT: ${EVOLUTION_DB_PORT_INTERNAL:-5432}
```

Sem elas, `config/evolution.js` caía nos defaults `localhost:5433` — que dentro do
container é o próprio container, e onde não há nada (o serviço
`evolution-postgres` escuta em 5432 e não publica porta). A consulta de ACK
falhava sempre, o `catch` devolvia `null`, e **todo envio era gravado com
`provider_status = "NAO_VERIFICADO"`** — inclusive os que o WhatsApp marcou com ACK
de erro, que é o único sinal capaz de reprovar um envio para grupo.

Como confirmar que passou a funcionar, depois do deploy:

```bash
ssh ubuntu@163.176.107.172 "cd ~/estimulo-project/infra && \
  docker compose logs dispatch-worker mensagens-dispatch-worker --since 1h | \
  grep -E 'delivery_confirmation.(lookup_unavailable|group_without_ack|confirmed)'"
```

- `lookup_unavailable` → ainda não alcança o banco; conferir as variáveis no container.
- `group_without_ack` / `confirmed` → a leitura de ACK voltou a funcionar.

E no banco, o sinal definitivo é `provider_status` deixar de ser sempre
`NAO_VERIFICADO`:

```sql
SELECT provider_status, count(*)
  FROM public.logs
 WHERE criado_em > now() - interval '1 day'
 GROUP BY 1 ORDER BY 2 DESC;
```
