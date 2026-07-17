ALTER TABLE public.video_catalog
    ADD COLUMN IF NOT EXISTS link_video text,
    ADD COLUMN IF NOT EXISTS google_drive_created_at timestamptz;

DROP TRIGGER IF EXISTS trg_video_catalog_updated_at ON public.video_catalog;

ALTER TABLE public.video_catalog
    ALTER COLUMN drive_file_id DROP NOT NULL;

ALTER TABLE public.video_catalog
    DROP CONSTRAINT IF EXISTS video_catalog_status_check;

ALTER TABLE public.video_catalog
    DROP CONSTRAINT IF EXISTS video_catalog_status_valido;

ALTER TABLE public.video_catalog
    ALTER COLUMN status DROP DEFAULT;

ALTER TABLE public.video_catalog
    ALTER COLUMN status TYPE boolean
    USING (
        CASE
            WHEN status IS NULL THEN false
            WHEN lower(status::text) IN ('true', 't', '1', 'sim', 'aprovado') THEN true
            ELSE false
        END
    );

ALTER TABLE public.video_catalog
    ALTER COLUMN status SET DEFAULT false,
    ALTER COLUMN status SET NOT NULL;

UPDATE public.video_catalog
SET status = true
WHERE drive_file_id IS NOT NULL
  AND link_video IS NOT NULL;
