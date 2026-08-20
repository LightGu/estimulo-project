ALTER TABLE public.campaigns
    DROP CONSTRAINT IF EXISTS campaigns_status_check;

ALTER TABLE public.campaigns
    ADD CONSTRAINT campaigns_status_check
    CHECK (status IN ('gerando_legendas', 'programado', 'pausado', 'cancelado', 'concluido'));

ALTER TABLE public.campaigns
    ADD COLUMN IF NOT EXISTS paused_at timestamptz,
    ADD COLUMN IF NOT EXISTS total_paused_ms bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS trigger_fired_at timestamptz,
    ADD COLUMN IF NOT EXISTS campaign_trigger_job_id text,
    ADD COLUMN IF NOT EXISTS link_conteudo_tipo text;

ALTER TABLE public.logs
    ADD COLUMN IF NOT EXISTS dispatch_job_id text;

ALTER TABLE public.logs
    DROP CONSTRAINT IF EXISTS logs_status_check;

ALTER TABLE public.logs
    ADD CONSTRAINT logs_status_check
    CHECK (status IN ('pendente', 'processando', 'enviado', 'erro', 'falhou', 'cancelado'));
