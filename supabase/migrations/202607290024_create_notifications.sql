CREATE TABLE IF NOT EXISTS public.notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    type text NOT NULL,
    message text NOT NULL,
    group_id uuid REFERENCES public.groups(id) ON DELETE CASCADE,
    read_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_created_at_idx ON public.notifications (created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_read_at_idx ON public.notifications (read_at);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'notifications' AND policyname = 'notifications_select_policy'
    ) THEN
        CREATE POLICY notifications_select_policy ON public.notifications
            FOR SELECT
            USING (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'notifications' AND policyname = 'notifications_insert_policy'
    ) THEN
        CREATE POLICY notifications_insert_policy ON public.notifications
            FOR INSERT
            WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'notifications' AND policyname = 'notifications_update_policy'
    ) THEN
        CREATE POLICY notifications_update_policy ON public.notifications
            FOR UPDATE
            USING (true)
            WITH CHECK (true);
    END IF;
END $$;
