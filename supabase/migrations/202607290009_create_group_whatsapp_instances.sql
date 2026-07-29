CREATE TABLE IF NOT EXISTS public.group_whatsapp_instances (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id uuid NOT NULL,
    whatsapp_instance_id uuid NOT NULL,
    discovered_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_group_whatsapp_instances_group
        FOREIGN KEY (group_id)
        REFERENCES public.groups(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT fk_group_whatsapp_instances_instance
        FOREIGN KEY (whatsapp_instance_id)
        REFERENCES public.whatsapp_instances(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT uq_group_whatsapp_instances UNIQUE (group_id, whatsapp_instance_id)
);

CREATE INDEX IF NOT EXISTS idx_group_whatsapp_instances_group_id ON public.group_whatsapp_instances (group_id);
CREATE INDEX IF NOT EXISTS idx_group_whatsapp_instances_instance_id ON public.group_whatsapp_instances (whatsapp_instance_id);

ALTER TABLE public.group_whatsapp_instances ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'group_whatsapp_instances' AND policyname = 'group_whatsapp_instances_select_policy'
    ) THEN
        CREATE POLICY group_whatsapp_instances_select_policy ON public.group_whatsapp_instances
            FOR SELECT
            USING (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'group_whatsapp_instances' AND policyname = 'group_whatsapp_instances_insert_policy'
    ) THEN
        CREATE POLICY group_whatsapp_instances_insert_policy ON public.group_whatsapp_instances
            FOR INSERT
            WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'group_whatsapp_instances' AND policyname = 'group_whatsapp_instances_update_policy'
    ) THEN
        CREATE POLICY group_whatsapp_instances_update_policy ON public.group_whatsapp_instances
            FOR UPDATE
            USING (true)
            WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'group_whatsapp_instances' AND policyname = 'group_whatsapp_instances_delete_policy'
    ) THEN
        CREATE POLICY group_whatsapp_instances_delete_policy ON public.group_whatsapp_instances
            FOR DELETE
            USING (true);
    END IF;
END $$;
