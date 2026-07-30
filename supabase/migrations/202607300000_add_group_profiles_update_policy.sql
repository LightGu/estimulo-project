-- Correcao: group_profiles foi criada (202607290011) com RLS habilitado e policies de
-- SELECT, INSERT e DELETE, mas sem policy de UPDATE. Com RLS ativo e nenhuma policy
-- permissiva de UPDATE, todo UPDATE casa zero linhas silenciosamente — e como o
-- repositorio usa .single(), o resultado vazio virava erro e a API respondia 500.
-- Isso quebrava renomear perfil, e tambem a fusao (que renomeia o sobrevivente).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'group_profiles' AND policyname = 'group_profiles_update_policy'
    ) THEN
        CREATE POLICY group_profiles_update_policy ON public.group_profiles
            FOR UPDATE
            USING (true)
            WITH CHECK (true);
    END IF;
END $$;
