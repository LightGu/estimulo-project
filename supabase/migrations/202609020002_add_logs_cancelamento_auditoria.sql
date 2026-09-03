-- Auditoria de cancelamento de envio.
--
-- Ate aqui um envio cancelado gravava so `status = 'cancelado'`. A tabela nao
-- tem `updated_at` (o trigger set_updated_at nunca foi ligado nela), entao NAO
-- existia registro de QUANDO o cancelamento aconteceu - a unica data da linha e
-- `criado_em`, que e a da criacao. Pior: `cancelPendingByCampaign` (cancelamento
-- pedido pelo usuario) nao escrevia `mensagem_erro`, enquanto a trava de atraso
-- escrevia - mas as duas origens ficavam indistinguiveis quando a mensagem era
-- nula por qualquer outro motivo.
--
-- O efeito pratico apareceu na investigacao do incidente de 02/09/2026: para
-- responder "quem cancelou estes 4 envios, o operador ou a propria plataforma?"
-- foi preciso engenharia reversa do codigo, porque o banco nao guardava a
-- resposta. Estas duas colunas fecham isso:
--
--   cancelado_em     - instante do cancelamento (nulo em quem nunca foi cancelado);
--   cancelado_origem - QUEM cancelou, em vocabulario fechado (ver CHECK abaixo).
--
-- Nulo em todo log existente: cancelamentos antigos permanecem sem essa
-- informacao (ela nunca foi gravada, entao nao ha o que reconstruir sem
-- inventar dado).
ALTER TABLE public.logs
ADD COLUMN IF NOT EXISTS cancelado_em timestamptz,
ADD COLUMN IF NOT EXISTS cancelado_origem text;

-- Vocabulario fechado para a coluna nao virar texto livre:
--   usuario             - acao explicita no painel (cancelar campanha);
--   atraso              - trava de atraso do worker (dispatch-staleness.js);
--   campanha_cancelada  - efeito em cascata do cancelamento da campanha;
--   sistema             - demais caminhos automaticos (fallback).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'logs_cancelado_origem_check'
    ) THEN
        ALTER TABLE public.logs
        ADD CONSTRAINT logs_cancelado_origem_check
        CHECK (
            cancelado_origem IS NULL
            OR cancelado_origem IN ('usuario', 'atraso', 'campanha_cancelada', 'sistema')
        );
    END IF;
END
$$;

COMMENT ON COLUMN public.logs.cancelado_em IS
    'Instante em que o envio foi cancelado. Nulo enquanto o log nunca foi cancelado.';
COMMENT ON COLUMN public.logs.cancelado_origem IS
    'Origem do cancelamento: usuario | atraso | campanha_cancelada | sistema.';
