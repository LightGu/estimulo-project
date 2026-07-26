CREATE TABLE IF NOT EXISTS public.campaign_video_captions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id uuid NOT NULL,
    group_id uuid NOT NULL,
    video_id uuid NOT NULL,
    caption_id uuid,
    caption_text text,
    status text NOT NULL DEFAULT 'processando' CHECK (
        status IN ('processando', 'gerado', 'erro')
    ),
    erro_mensagem text,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_campaign_video_captions_campaign
        FOREIGN KEY (campaign_id)
        REFERENCES public.campaigns(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT fk_campaign_video_captions_group
        FOREIGN KEY (group_id)
        REFERENCES public.groups(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT fk_campaign_video_captions_video
        FOREIGN KEY (video_id)
        REFERENCES public.video_catalog(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT fk_campaign_video_captions_caption
        FOREIGN KEY (caption_id)
        REFERENCES public.video_captions(id)
        ON DELETE SET NULL
        ON UPDATE CASCADE,
    CONSTRAINT uq_campaign_video_captions UNIQUE (campaign_id, group_id, video_id)
);

ALTER TABLE public.campaign_video_captions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'campaign_video_captions'
          AND policyname = 'campaign_video_captions_select_policy'
    ) THEN
        CREATE POLICY campaign_video_captions_select_policy ON public.campaign_video_captions
            FOR SELECT
            USING (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'campaign_video_captions'
          AND policyname = 'campaign_video_captions_insert_policy'
    ) THEN
        CREATE POLICY campaign_video_captions_insert_policy ON public.campaign_video_captions
            FOR INSERT
            WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'campaign_video_captions'
          AND policyname = 'campaign_video_captions_update_policy'
    ) THEN
        CREATE POLICY campaign_video_captions_update_policy ON public.campaign_video_captions
            FOR UPDATE
            USING (true)
            WITH CHECK (true);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_campaign_video_captions_campaign
    ON public.campaign_video_captions (campaign_id);
