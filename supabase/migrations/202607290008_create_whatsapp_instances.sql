CREATE TABLE IF NOT EXISTS public.whatsapp_instances (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_name text NOT NULL UNIQUE,
    phone_number text,
    connection_state text NOT NULL DEFAULT 'pending' CHECK (
        connection_state IN ('pending', 'connecting', 'open', 'close', 'disconnected')
    ),
    priority integer NOT NULL DEFAULT 0,
    active boolean NOT NULL DEFAULT true,
    qr_generated_at timestamptz,
    connected_at timestamptz,
    last_status_check_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_instances_priority ON public.whatsapp_instances (priority) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_whatsapp_instances_active ON public.whatsapp_instances (active);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'trg_whatsapp_instances_updated_at'
    ) THEN
        CREATE TRIGGER trg_whatsapp_instances_updated_at
        BEFORE UPDATE ON public.whatsapp_instances
        FOR EACH ROW
        EXECUTE FUNCTION public.set_updated_at();
    END IF;
END $$;

ALTER TABLE public.whatsapp_instances ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'whatsapp_instances' AND policyname = 'whatsapp_instances_select_policy'
    ) THEN
        CREATE POLICY whatsapp_instances_select_policy ON public.whatsapp_instances
            FOR SELECT
            USING (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'whatsapp_instances' AND policyname = 'whatsapp_instances_insert_policy'
    ) THEN
        CREATE POLICY whatsapp_instances_insert_policy ON public.whatsapp_instances
            FOR INSERT
            WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'whatsapp_instances' AND policyname = 'whatsapp_instances_update_policy'
    ) THEN
        CREATE POLICY whatsapp_instances_update_policy ON public.whatsapp_instances
            FOR UPDATE
            USING (true)
            WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'whatsapp_instances' AND policyname = 'whatsapp_instances_delete_policy'
    ) THEN
        CREATE POLICY whatsapp_instances_delete_policy ON public.whatsapp_instances
            FOR DELETE
            USING (true);
    END IF;
END $$;
