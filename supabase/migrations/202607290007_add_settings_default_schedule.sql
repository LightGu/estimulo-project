ALTER TABLE public.settings
    ADD COLUMN IF NOT EXISTS default_timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
    ADD COLUMN IF NOT EXISTS default_min_interval_min integer NOT NULL DEFAULT 4,
    ADD COLUMN IF NOT EXISTS default_max_interval_min integer NOT NULL DEFAULT 12;
