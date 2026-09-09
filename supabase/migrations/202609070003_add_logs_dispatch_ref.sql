-- Coluna de correlacao de envio.
--
-- POR QUE ELA EXISTE.
--
-- O caminho de envio atravessa tres fronteiras (Postgres, Redis/BullMQ,
-- Evolution API) e cada camada identificava o envio de um jeito diferente - o
-- pior detalhe sendo que `group_id` significa o JID da Evolution no job e a PK
-- do Postgres no log, invertido em relacao a `progress_group_id`. Os dois
-- identificadores mais uteis (log_id e provider_message_id) so passam a existir
-- no meio do caminho. Resultado pratico: um caso relatado pelo cliente ("esse
-- grupo nao recebeu ontem as 14h") nao tinha chave de busca, e investigar era
-- juntar linhas por proximidade temporal no log de sete containers.
--
-- `dispatch_ref` e' deterministico (ver src/utils/dispatch-ref.js): o log e o
-- job sao criados por processos diferentes - a confirmacao na API cria o log, o
-- trigger cria o job - e chegam ao mesmo valor sem se falarem. Com ele, um unico
-- grep encontra o envio em todos os containers, e a mesma string liga a linha do
-- relatorio ao job da fila e ao evento do Sentry.
--
-- NAO e' chave de unicidade: quem garante "um envio por trio" e' o indice
-- idx_logs_trio_ativo (migration 202609070002). Aqui o indice existe apenas para
-- a busca ser barata.

ALTER TABLE public.logs
    ADD COLUMN IF NOT EXISTS dispatch_ref text;

CREATE INDEX IF NOT EXISTS idx_logs_dispatch_ref
    ON public.logs (dispatch_ref)
    WHERE dispatch_ref IS NOT NULL;

COMMENT ON COLUMN public.logs.dispatch_ref IS
    'Identificador de correlacao do envio, deterministico, propagado ate os logs '
    'estruturados dos workers e as tags do Sentry. Ver src/utils/dispatch-ref.js.';
