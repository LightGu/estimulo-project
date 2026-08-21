ALTER TABLE public.campaigns
    ADD COLUMN IF NOT EXISTS possui_midia boolean NOT NULL DEFAULT false;
