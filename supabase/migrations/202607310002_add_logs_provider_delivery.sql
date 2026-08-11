-- A Evolution API devolve, em todo envio aceito, a chave da mensagem
-- (data.key.id) e o estado inicial dela (data.status, tipicamente "PENDING").
-- Essa resposta era descartada: o log virava "enviado" sem nenhuma evidencia
-- associada, e um envio que a API aceitou mas o WhatsApp nunca entregou ficava
-- indistinguivel de um envio entregue. Guardar os dois campos torna esse caso
-- auditavel depois do fato.
ALTER TABLE public.logs
ADD COLUMN IF NOT EXISTS provider_message_id text;

ALTER TABLE public.logs
ADD COLUMN IF NOT EXISTS provider_status text;
