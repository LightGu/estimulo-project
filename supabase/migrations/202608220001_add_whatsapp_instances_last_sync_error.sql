ALTER TABLE public.whatsapp_instances
    ADD COLUMN IF NOT EXISTS last_sync_attempt_at timestamptz,
    ADD COLUMN IF NOT EXISTS last_sync_error text;
