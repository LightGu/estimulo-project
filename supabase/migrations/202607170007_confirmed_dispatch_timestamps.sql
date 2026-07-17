ALTER TABLE public.campaigns
    ALTER COLUMN data_envio DROP NOT NULL,
    ALTER COLUMN horario_envio DROP NOT NULL;

ALTER TABLE public.campaign_groups
    ADD COLUMN IF NOT EXISTS enviado_em timestamptz;

CREATE INDEX IF NOT EXISTS idx_campaign_groups_enviado_em
    ON public.campaign_groups (enviado_em);
