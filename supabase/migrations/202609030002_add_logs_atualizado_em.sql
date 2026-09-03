-- "Atualizado em" de verdade na tabela de envios.
--
-- A coluna "Atualizado em" do modal de campanha renderizava `criado_em`, ou
-- seja, o instante em que o log foi CRIADO. No cancelamento de 03/09/2026 isso
-- fez a tela mostrar 02:34:07 (quando o trigger agendou os 34 envios) para um
-- cancelamento que aconteceu as 12:16:07 - quase dez horas depois. Quem olhou o
-- relatorio leu o horario errado como se fosse o do cancelamento.
--
-- A causa e' que `logs` nunca teve coluna de atualizacao: o trigger
-- set_updated_at (202607140001) foi ligado em outras tabelas, nunca nesta. Com
-- isso, nenhuma transicao de status - enviado, falhou, cancelado - deixava
-- registro de QUANDO aconteceu. `cancelado_em` (202609020002) resolveu so o
-- caso do cancelamento; esta coluna cobre as demais.
--
-- Sobre nao fazer backfill: `ADD COLUMN ... DEFAULT now()` preencheria TODO log
-- existente com o horario da migration, afirmando que envios de semanas atras
-- foram atualizados agora - trocaria um dado errado por outro. As linhas
-- antigas ficam NULL (nao sabemos, e nao vamos inventar) e a tela cai de volta
-- para `criado_em` avisando que e a data de criacao. O DEFAULT entra depois do
-- ADD COLUMN, entao vale so para linhas novas.
ALTER TABLE public.logs
ADD COLUMN IF NOT EXISTS atualizado_em timestamptz;

ALTER TABLE public.logs
ALTER COLUMN atualizado_em SET DEFAULT now();

CREATE OR REPLACE FUNCTION public.set_logs_atualizado_em()
RETURNS TRIGGER AS $$
BEGIN
    NEW.atualizado_em = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- No BEFORE UPDATE (e nao na aplicacao) de proposito: os envios sao atualizados
-- por varios caminhos - workers de video e de texto, retry, confirmacao de
-- entrega, cancelamento em cascata - e um deles esquecer de carimbar a coluna
-- reproduziria exatamente o buraco que esta migration fecha.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_logs_atualizado_em'
    ) THEN
        CREATE TRIGGER trg_logs_atualizado_em
        BEFORE UPDATE ON public.logs
        FOR EACH ROW
        EXECUTE FUNCTION public.set_logs_atualizado_em();
    END IF;
END
$$;

COMMENT ON COLUMN public.logs.atualizado_em IS
    'Instante da ultima alteracao do envio, mantido pelo trigger trg_logs_atualizado_em. Nulo em logs anteriores a 202609030002.';
