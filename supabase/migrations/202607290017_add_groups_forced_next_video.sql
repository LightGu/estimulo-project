ALTER TABLE public.groups
    ADD COLUMN IF NOT EXISTS forced_next_video_id uuid REFERENCES public.video_catalog(id) ON DELETE SET NULL;
