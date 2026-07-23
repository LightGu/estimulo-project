CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.video_captions
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();

UPDATE public.video_captions
SET id = gen_random_uuid()
WHERE id IS NULL;

ALTER TABLE public.video_captions
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_video_captions_id
    ON public.video_captions (id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.video_captions'::regclass
          AND contype = 'p'
    ) THEN
        ALTER TABLE public.video_captions
            ADD CONSTRAINT video_captions_pkey PRIMARY KEY USING INDEX idx_video_captions_id;
    END IF;
END $$;
