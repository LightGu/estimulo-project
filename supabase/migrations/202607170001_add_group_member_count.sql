ALTER TABLE public.groups
ADD COLUMN IF NOT EXISTS quantidade_membros integer NOT NULL DEFAULT 0
CHECK (quantidade_membros >= 0);
