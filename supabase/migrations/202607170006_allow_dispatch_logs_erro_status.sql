CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
    IF to_regclass('public.logs') IS NULL
       AND to_regclass('public.dispatch_logs') IS NOT NULL THEN
        ALTER TABLE public.dispatch_logs RENAME TO logs;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id uuid NOT NULL,
    group_id uuid NOT NULL,
    video_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'pendente',
    mensagem_erro text,
    criado_em timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_logs_campaign
        FOREIGN KEY (campaign_id)
        REFERENCES public.campaigns(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT fk_logs_group
        FOREIGN KEY (group_id)
        REFERENCES public.groups(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT fk_logs_video
        FOREIGN KEY (video_id)
        REFERENCES public.video_catalog(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

DO $$
BEGIN
    IF to_regclass('public.dispatch_logs') IS NOT NULL THEN
        INSERT INTO public.logs (
            id,
            campaign_id,
            group_id,
            video_id,
            status,
            mensagem_erro,
            criado_em
        )
        SELECT
            id,
            campaign_id,
            group_id,
            video_id,
            status,
            mensagem_erro,
            criado_em
        FROM public.dispatch_logs
        ON CONFLICT (id) DO NOTHING;

        DROP TABLE public.dispatch_logs;
    END IF;
END $$;

DO $$
BEGIN
    ALTER TABLE public.logs
        DROP CONSTRAINT IF EXISTS dispatch_logs_status_check;

    ALTER TABLE public.logs
        DROP CONSTRAINT IF EXISTS logs_status_check;

    ALTER TABLE public.logs
        ADD CONSTRAINT logs_status_check
        CHECK (status IN ('pendente', 'processando', 'enviado', 'erro', 'falhou'));
END $$;

CREATE INDEX IF NOT EXISTS idx_logs_campaign_id ON public.logs (campaign_id);
CREATE INDEX IF NOT EXISTS idx_logs_group_id ON public.logs (group_id);
CREATE INDEX IF NOT EXISTS idx_logs_criado_em ON public.logs (criado_em);
CREATE INDEX IF NOT EXISTS idx_logs_campaign_group_created ON public.logs (campaign_id, group_id, criado_em);
