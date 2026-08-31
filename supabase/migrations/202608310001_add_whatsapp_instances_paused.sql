-- Pausa de um numero da Evolution API.
--
-- Pausar NAO desconecta a instancia: o numero continua logado no WhatsApp e a
-- sessao segue viva na Evolution. Ele apenas deixa de ser usado pela plataforma
-- para enviar qualquer mensagem (envio automatizado e disparador pontual) ate
-- ser despausado.
--
-- Coluna separada de `active` de proposito. `active` marca a instancia como
-- cadastrada/utilizavel no sistema e e o que a listagem da tela le; `paused_at`
-- e um estado operacional temporario e reversivel. Manter os dois separados
-- deixa a linha intacta na UI (a pessoa precisa ver o numero pausado para poder
-- despausar) enquanto os caminhos de disparo a ignoram.
--
-- Guardado como timestamp em vez de boolean para registrar TAMBEM desde quando
-- o numero esta pausado - util ao investigar uma campanha que enviou menos do
-- que o esperado. NULL = ativo para disparo.
ALTER TABLE public.whatsapp_instances
    ADD COLUMN IF NOT EXISTS paused_at timestamptz;

-- Indice parcial que espelha idx_whatsapp_instances_priority, cobrindo a query
-- quente do disparo (listDispatchable: active = true AND paused_at IS NULL,
-- ordenado por prioridade).
CREATE INDEX IF NOT EXISTS idx_whatsapp_instances_dispatchable
    ON public.whatsapp_instances (priority)
    WHERE active = true AND paused_at IS NULL;
