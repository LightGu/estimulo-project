ALTER TABLE public.groups
ALTER COLUMN segmento DROP NOT NULL;

ALTER TABLE public.groups
ALTER COLUMN envia_video SET DEFAULT false;
