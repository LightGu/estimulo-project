ALTER TABLE public.campaigns
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'programado'
        CHECK (status IN ('gerando_legendas', 'programado', 'concluido'));

CREATE INDEX IF NOT EXISTS idx_campaigns_data_envio ON public.campaigns (data_envio);
