-- Alinha a constraint de campaigns.classificacao com as opcoes que o app oferece.
--
-- INCIDENTE QUE ORIGINOU ESTA MIGRATION (04/09/2026, 21:13 e 21:45 UTC).
-- A tela do Disparador Pontual oferece "Capacitacao"
-- (public/app/mensagens.html) e mensagens.service.js aceita o valor
-- ("capacitacao" esta em CLASSIFICACOES), mas a constraint criada em
-- 202607290021_add_campaigns_ad_hoc_fields.sql lista apenas
-- ('evento','credito','pesquisa','aviso','outro') - sem "capacitacao".
--
-- O efeito nao foi um erro na tela: em dispatchAdHoc as mensagens sao enviadas
-- ANTES de a campanha ancora ser gravada, e a gravacao vive dentro de um
-- try/catch que apenas registra o evento. Resultado observado duas vezes no log
-- de producao:
--
--   {"event":"mensagens.persist_ad_hoc_campaign_failed",
--    "error_message":"new row for relation \"campaigns\" violates check
--                     constraint \"campaigns_classificacao_check\""}
--
-- ... com as mensagens ja entregues nos grupos e NENHUMA linha em `logs`. Os
-- envios existiram no WhatsApp e nunca existiram no relatorio operacional.
--
-- Esta migration corrige a divergencia de schema. A perda silenciosa em si e'
-- corrigida em mensagens.service.js (campanha e logs pendentes gravados antes
-- do envio, falha propagada em vez de engolida), e tests/mensagens-
-- classificacao-schema-contract.test.js passa a travar as duas listas juntas
-- para que a proxima classificacao nova nao repita o incidente.
DO $$
BEGIN
    ALTER TABLE public.campaigns
        DROP CONSTRAINT IF EXISTS campaigns_classificacao_check;

    ALTER TABLE public.campaigns
        ADD CONSTRAINT campaigns_classificacao_check
        CHECK (classificacao IN ('evento', 'credito', 'pesquisa', 'aviso', 'capacitacao', 'outro'));
END $$;
