-- O relatorio operacional mostrava o conteudo enviado mas nao qual numero de
-- WhatsApp (das instancias em rodizio) efetivamente enviou. `logs` nao tinha
-- coluna nenhuma para isso - o whatsapp_instance_id so existia no job da fila
-- (BullMQ) e se perdia assim que o envio terminava. Fica nulo em logs antigos
-- (nunca foi registrado) e em envios que cairam no fallback sem instancia
-- cadastrada (ver evolution-instance-sender.js).
ALTER TABLE public.logs
ADD COLUMN IF NOT EXISTS whatsapp_instance_id uuid REFERENCES public.whatsapp_instances(id);
