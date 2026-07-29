DO $$
DECLARE
    check_name text;
BEGIN
    SELECT con.conname INTO check_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'trilha_perfis'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%perfil%';

    IF check_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.trilha_perfis DROP CONSTRAINT %I', check_name);
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
          AND con.conname = 'fk_trilha_perfis_group_profiles'
    ) THEN
        ALTER TABLE public.trilha_perfis
            ADD CONSTRAINT fk_trilha_perfis_group_profiles
            FOREIGN KEY (perfil) REFERENCES public.group_profiles (nome)
            ON DELETE RESTRICT;
    END IF;
END $$;
