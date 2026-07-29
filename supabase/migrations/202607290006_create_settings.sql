CREATE TABLE IF NOT EXISTS public.settings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key text NOT NULL UNIQUE DEFAULT 'global',
    drive_root_folder_id text,
    drive_index_cron text NOT NULL DEFAULT '0 3 * * *',
    drive_index_timezone text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'trg_settings_updated_at'
    ) THEN
        CREATE TRIGGER trg_settings_updated_at
        BEFORE UPDATE ON public.settings
        FOR EACH ROW
        EXECUTE FUNCTION public.set_updated_at();
    END IF;
END $$;

ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'settings' AND policyname = 'settings_select_policy'
    ) THEN
        CREATE POLICY settings_select_policy ON public.settings
            FOR SELECT
            USING (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'settings' AND policyname = 'settings_insert_policy'
    ) THEN
        CREATE POLICY settings_insert_policy ON public.settings
            FOR INSERT
            WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'settings' AND policyname = 'settings_update_policy'
    ) THEN
        CREATE POLICY settings_update_policy ON public.settings
            FOR UPDATE
            USING (true)
            WITH CHECK (true);
    END IF;
END $$;

INSERT INTO public.settings (key)
SELECT 'global'
WHERE NOT EXISTS (
    SELECT 1 FROM public.settings WHERE key = 'global'
);
