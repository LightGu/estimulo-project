DROP INDEX IF EXISTS idx_campaign_groups_enviado_em;

ALTER TABLE public.campaign_groups
    DROP COLUMN IF EXISTS enviado_em;
