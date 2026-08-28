ALTER TABLE public.trilha_perfis
    ADD COLUMN IF NOT EXISTS profile_id uuid;

UPDATE public.trilha_perfis AS tp
SET profile_id = gp.id
FROM public.group_profiles AS gp
WHERE gp.nome = tp.perfil
  AND tp.profile_id IS NULL;

DO $$
DECLARE
    orfaos integer;
BEGIN
    SELECT count(*) INTO orfaos FROM public.trilha_perfis WHERE profile_id IS NULL;
    IF orfaos > 0 THEN
        RAISE WARNING 'trilha_perfis: % linha(s) sem profile_id correspondente apos migracao', orfaos;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
        WHERE nsp.nspname = 'public'
          AND rel.relname = 'trilha_perfis'
          AND con.conname = 'fk_trilha_perfis_profile_id'
    ) THEN
        ALTER TABLE public.trilha_perfis
            ADD CONSTRAINT fk_trilha_perfis_profile_id
            FOREIGN KEY (profile_id) REFERENCES public.group_profiles (id)
            ON DELETE RESTRICT;
    END IF;
END $$;

ALTER TABLE public.trilha_perfis DROP CONSTRAINT IF EXISTS uq_trilha_perfis_v2;

-- Postgres nao tem ADD CONSTRAINT IF NOT EXISTS, entao a criacao vai na mesma
-- guarda usada pelas FKs acima. Sem ela esta era a unica DDL nao reexecutavel do
-- arquivo: com a migration ja aplicada fora do historico do supabase_migrations,
-- o `supabase db push` falhava aqui ("constraint already exists") e nao chegava
-- nas migrations seguintes.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
        WHERE nsp.nspname = 'public'
          AND rel.relname = 'trilha_perfis'
          AND con.conname = 'uq_trilha_perfis_v3'
    ) THEN
        ALTER TABLE public.trilha_perfis
            ADD CONSTRAINT uq_trilha_perfis_v3 UNIQUE (trilha_id, profile_id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_trilha_perfis_profile_id ON public.trilha_perfis (profile_id);

ALTER TABLE public.groups
    ADD COLUMN IF NOT EXISTS profile_id uuid;

UPDATE public.groups AS g
SET profile_id = gp.id
FROM public.group_profiles AS gp
WHERE gp.nome = g.segmento
  AND g.profile_id IS NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
        WHERE nsp.nspname = 'public'
          AND rel.relname = 'groups'
          AND con.conname = 'fk_groups_profile_id'
    ) THEN
        ALTER TABLE public.groups
            ADD CONSTRAINT fk_groups_profile_id
            FOREIGN KEY (profile_id) REFERENCES public.group_profiles (id)
            ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_groups_profile_id ON public.groups (profile_id);

-- Colunas legadas trilha_perfis.perfil e groups.segmento (text) sao mantidas por 1 ciclo,
-- sincronizadas via triggers (ver 202607300002_sync_profile_text_columns.sql), para nao quebrar
-- leituras existentes enquanto o codigo migra para profile_id.
