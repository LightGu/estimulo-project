-- "dispatch_logs_status_valido" e uma constraint de CHECK legada, de antes da
-- tabela ser renomeada de dispatch_logs para logs (202607170006), que nunca
-- foi removida. Ela ficou coexistindo com "logs_status_check" (a constraint
-- que este projeto de fato mantem atualizada) e o Postgres aplica as duas ao
-- mesmo tempo - qualquer valor de status novo precisa passar por ambas.
--
-- Ela ainda so aceita ('pendente','processando','enviado','falhou'), sem
-- 'erro' nem 'cancelado', e por isso bloqueava o cancelamento de campanha
-- (UPDATE logs SET status='cancelado' ...) mesmo depois de
-- 202608140001_add_campaigns_pause_cancel.sql liberar 'cancelado' em
-- logs_status_check.
ALTER TABLE public.logs
    DROP CONSTRAINT IF EXISTS dispatch_logs_status_valido;
