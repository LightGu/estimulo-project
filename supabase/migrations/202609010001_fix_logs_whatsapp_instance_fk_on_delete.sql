-- Remover um numero na tela de Configuracoes falhava com "Internal server
-- error" sempre que aquele numero ja tinha disparado alguma mensagem.
--
-- Causa: a FK criada em 202608280004_add_logs_whatsapp_instance.sql nao
-- declarou ON DELETE, entao o Postgres aplicou o padrao NO ACTION - qualquer
-- linha em `logs` referenciando a instancia bloqueava o DELETE com
--   23503: update or delete on table "whatsapp_instances" violates foreign key
--   constraint "logs_whatsapp_instance_id_fkey" on table "logs"
-- Numeros recem-cadastrados (sem historico de envio) removiam normalmente, o
-- que mascarava o problema.
--
-- SET NULL e o comportamento correto aqui: `logs` e historico operacional e
-- precisa sobreviver a remocao do numero. A coluna ja nasceu nullable
-- justamente porque logs antigos (anteriores a coluna) e envios pelo fallback
-- sem instancia cadastrada tambem ficam nulos - um log sem numero associado ja
-- e um estado esperado pelo relatorio.
ALTER TABLE public.logs
    DROP CONSTRAINT IF EXISTS logs_whatsapp_instance_id_fkey;

ALTER TABLE public.logs
    ADD CONSTRAINT logs_whatsapp_instance_id_fkey
        FOREIGN KEY (whatsapp_instance_id)
        REFERENCES public.whatsapp_instances(id)
        ON DELETE SET NULL;
