CREATE TABLE IF NOT EXISTS public.video_captions (
    video_id uuid PRIMARY KEY,
    caption_text text NOT NULL,
    criado_em timestamptz NOT NULL DEFAULT now(),
    ultimo_uso_em timestamptz,
    CONSTRAINT fk_video_captions_video
        FOREIGN KEY (video_id)
        REFERENCES public.video_catalog(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

ALTER TABLE public.video_captions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'video_captions'
          AND policyname = 'video_captions_select_policy'
    ) THEN
        CREATE POLICY video_captions_select_policy ON public.video_captions
            FOR SELECT
            USING (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'video_captions'
          AND policyname = 'video_captions_insert_policy'
    ) THEN
        CREATE POLICY video_captions_insert_policy ON public.video_captions
            FOR INSERT
            WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'video_captions'
          AND policyname = 'video_captions_update_policy'
    ) THEN
        CREATE POLICY video_captions_update_policy ON public.video_captions
            FOR UPDATE
            USING (true)
            WITH CHECK (true);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_video_captions_ultimo_uso_em
    ON public.video_captions (ultimo_uso_em);
