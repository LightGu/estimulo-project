ALTER TABLE public.settings
    ADD COLUMN IF NOT EXISTS profile_name text NOT NULL DEFAULT 'Lina Chaim';
