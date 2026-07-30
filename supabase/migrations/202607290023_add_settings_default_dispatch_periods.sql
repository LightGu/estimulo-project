ALTER TABLE public.settings
    ADD COLUMN IF NOT EXISTS default_dispatch_periods jsonb NOT NULL DEFAULT '[]'::jsonb;
