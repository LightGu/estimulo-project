ALTER TABLE public.campaigns
    ADD COLUMN IF NOT EXISTS status_changed_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION public.set_campaigns_status_changed_at()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        NEW.status_changed_at = now();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'trg_campaigns_status_changed_at'
    ) THEN
        CREATE TRIGGER trg_campaigns_status_changed_at
        BEFORE UPDATE ON public.campaigns
        FOR EACH ROW
        EXECUTE FUNCTION public.set_campaigns_status_changed_at();
    END IF;
END $$;
