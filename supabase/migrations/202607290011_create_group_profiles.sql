CREATE TABLE IF NOT EXISTS public.group_profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nome text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.group_profiles ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'group_profiles' AND policyname = 'group_profiles_select_policy'
    ) THEN
        CREATE POLICY group_profiles_select_policy ON public.group_profiles
            FOR SELECT
            USING (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'group_profiles' AND policyname = 'group_profiles_insert_policy'
    ) THEN
        CREATE POLICY group_profiles_insert_policy ON public.group_profiles
            FOR INSERT
            WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'group_profiles' AND policyname = 'group_profiles_delete_policy'
    ) THEN
        CREATE POLICY group_profiles_delete_policy ON public.group_profiles
            FOR DELETE
            USING (true);
    END IF;
END $$;

INSERT INTO public.group_profiles (nome)
SELECT nome FROM (VALUES ('Pré-infância'), ('Infância'), ('Adolescência'), ('Maturidade')) AS seed(nome)
WHERE NOT EXISTS (SELECT 1 FROM public.group_profiles WHERE group_profiles.nome = seed.nome);
