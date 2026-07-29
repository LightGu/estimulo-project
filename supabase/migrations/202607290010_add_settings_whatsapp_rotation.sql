ALTER TABLE public.settings
    ADD COLUMN IF NOT EXISTS whatsapp_rotation_group_count integer NOT NULL DEFAULT 1 CHECK (whatsapp_rotation_group_count >= 1);
