ALTER TABLE public.campaigns
    ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'trilha'
        CHECK (tipo IN ('trilha', 'pontual')),
    ADD COLUMN IF NOT EXISTS titulo text,
    ADD COLUMN IF NOT EXISTS classificacao text
        CHECK (classificacao IN ('evento', 'credito', 'pesquisa', 'aviso', 'outro')),
    ADD COLUMN IF NOT EXISTS texto_mensagem text,
    ADD COLUMN IF NOT EXISTS link_conteudo text,
    ADD COLUMN IF NOT EXISTS jitter_delay_min_ms integer,
    ADD COLUMN IF NOT EXISTS jitter_delay_max_ms integer;

CREATE INDEX IF NOT EXISTS idx_campaigns_tipo ON public.campaigns (tipo);
