-- Indice unico parcial no trio (campaign_id, group_id, video_id) para os
-- estados que significam "envio em andamento ou concluido".
--
-- POR QUE ELE E' A DEFESA CERTA.
--
-- A checagem de idempotencia do envio (createAttemptLog em
-- services/dispatch-consistency.service.js) e' feita em tres round-trips
-- separados - busca "processando", busca "pendente", cria - sem atomicidade
-- entre eles. O claimForSend seguinte e' um compare-and-set por `id` de LINHA,
-- entao ele protege uma linha, nunca o trio logico: se duas linhas nascem para o
-- mesmo trio, os dois claims tem sucesso e o mesmo video e' postado duas vezes
-- no grupo.
--
-- Havia duas janelas reais para isso, e nenhuma exigia escalar nada:
--
--   1. ensurePendingDispatchLogs (queues/campaign-trigger.js) lia a lista de
--      logs UMA vez e decidia criar ou nao contra esse array em memoria.
--      Enquanto o laco percorria os grupos (um INSERT por vez), o primeiro job
--      de disparo - que sai com delay 0 - ja estava no worker, onde
--      createAttemptLog nao encontrava log pendente e criava o seu. Resultado:
--      duas linhas para o mesmo trio, uma virando "enviado" e a outra presa em
--      "pendente" para sempre (nenhum job aponta para ela, e o sweep de retry
--      so varre "falhou"). Essa era a assinatura dos "logs orfaos" que o
--      rastreio TRACE_ORPHAN_DISPATCH_LOGS foi criado para investigar.
--
--   2. Qualquer futuro `--scale dispatch-worker=N` ou concurrency > 1. Hoje a
--      serializacao e' operacional (uma instancia no compose, concurrency 1 por
--      default da BullMQ), nao estrutural.
--
-- Com o indice, a corrida deixa de depender de ordem de execucao: o segundo
-- INSERT falha com 23505 e quem chama rele o log vencedor (tratado em
-- createAttemptLog e em ensurePendingDispatchLogs).
--
-- "falhou" e "cancelado" ficam FORA do WHERE de proposito: um trio pode
-- legitimamente ter varias tentativas falhadas no historico, e o sweep de retry
-- reaproveita o log existente via markRetrying (volta para "pendente"), entao
-- ele nunca cria linha nova para o mesmo trio.
--
-- CONCURRENTLY nao pode rodar dentro de bloco transacional; o SQL Editor do
-- Supabase executa cada statement solto, entao esta forma funciona la. Se a
-- criacao falhar por duplicatas pre-existentes, rode primeiro o diagnostico
-- abaixo e concilie as linhas antes de tentar de novo.
--
--   SELECT campaign_id, group_id, video_id, count(*) AS linhas,
--          array_agg(id ORDER BY criado_em) AS log_ids,
--          array_agg(status ORDER BY criado_em) AS status
--     FROM public.logs
--    WHERE status IN ('pendente','processando','enviado')
--    GROUP BY 1,2,3
--   HAVING count(*) > 1;
--
-- Conciliacao sugerida para o passivo: em cada grupo duplicado, preservar a
-- linha "enviado" (ou a mais recente) e marcar as demais como 'cancelado' com
-- cancelado_origem='sistema' e mensagem_erro explicando que era duplicata de
-- corrida - preserva o historico e nao inventa entrega que nao houve.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_logs_trio_ativo
    ON public.logs (campaign_id, group_id, video_id)
    WHERE status IN ('pendente', 'processando', 'enviado');

-- Sustenta findByTrio quando video_id e' NULL (disparo pontual de mensagem, que
-- nao tem video). O indice parcial acima nao cobre esse caso: no Postgres, NULL
-- nao e' igual a NULL, entao ele nao impede duas linhas com video_id nulo para o
-- mesmo par campanha/grupo - e nem deveria, porque a campanha ad-hoc e' criada
-- uma por disparo. Aqui o objetivo e' so a consulta ser barata.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_logs_campaign_group_video_status
    ON public.logs (campaign_id, group_id, video_id, status);
