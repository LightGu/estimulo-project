ALTER TABLE public.settings
    ADD COLUMN IF NOT EXISTS notification_group_id uuid REFERENCES public.groups(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS notification_events jsonb NOT NULL DEFAULT '{"campaignStarted": true, "campaignFinished": true, "dispatchFailure": true, "aiError": true}'::jsonb;
