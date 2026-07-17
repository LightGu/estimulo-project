ALTER TABLE public.groups
ADD COLUMN IF NOT EXISTS maturidade smallint NOT NULL DEFAULT 1
CHECK (maturidade BETWEEN 1 AND 4);
