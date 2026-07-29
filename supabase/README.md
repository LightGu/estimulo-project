# Migrations

`supabase/migrations/` e a fonte de verdade do schema. 45 arquivos, aplicados em
ordem de nome. `supabase/.temp/` e cache local do CLI e nao deve ser versionado.

```bash
supabase link --project-ref SEU_PROJECT_REF
supabase db push
```

## Por que os 45 arquivos continuam aqui

A refatoracao pre-deploy revisou esses arquivos. Existe churn real: 20 das 45
migrations sao do dia 29/07, 7 delas apenas adicionando uma coluna por vez em
`settings`, e varios pares adicionam e depois removem a mesma coluna
(`202607230002` cria colunas legadas de trilha em `video_catalog` e
`202607290005` as remove; `202607290002` torna `trilhas.organization_id`
nullable e `202607290004` remove a coluna).

Um baseline unico seria bem mais limpo. Mesmo assim **nenhum arquivo foi
removido**, porque estas migrations ja estao aplicadas no projeto Supabase em
uso. O Supabase registra cada versao aplicada em
`supabase_migrations.schema_migrations`; apagar ou fundir os arquivos localmente
desincroniza o historico e o proximo `supabase db push` passa a falhar ou a
tentar recriar objetos que ja existem. O ganho e cosmetico e o risco recai sobre
o banco que ja tem dados.

## Como fazer o squash com seguranca, se quiser

O momento certo e ao criar o projeto de producao, nao antes. Deixe o CLI gerar o
baseline a partir do banco real, em vez de concatenar os arquivos na mao:

```bash
# 1. baseline gerado a partir do estado atual do banco
supabase db dump --linked -f supabase/migrations/<timestamp>_baseline.sql

# 2. mova os 45 arquivos antigos para fora de migrations/ e guarde num branch
#    ou tag antes de apagar

# 3. marque os antigos como ja aplicados e o baseline como revertido,
#    para o historico remoto continuar coerente
supabase migration list
supabase migration repair --status reverted <versao_antiga> ...
supabase migration repair --status applied <timestamp_do_baseline>
```

Valide em um projeto Supabase descartavel antes de rodar contra producao, e
confirme que `supabase db push` fica limpo nos dois ambientes.

Ate isso acontecer, a regra e simples: **nao edite migration ja aplicada**,
sempre adicione um arquivo novo.
