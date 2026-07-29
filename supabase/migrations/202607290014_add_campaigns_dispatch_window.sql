ALTER TABLE public.campaigns
    ADD COLUMN IF NOT EXISTS window_start timestamptz,
    ADD COLUMN IF NOT EXISTS window_end timestamptz;
