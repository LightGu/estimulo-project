ALTER TABLE public.video_catalog
    ADD COLUMN IF NOT EXISTS transcript text;
