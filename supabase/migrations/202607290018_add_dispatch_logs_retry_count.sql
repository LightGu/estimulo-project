ALTER TABLE public.logs
    ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0;
