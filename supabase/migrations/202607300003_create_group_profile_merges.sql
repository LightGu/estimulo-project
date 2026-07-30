-- Histórico de fusões de perfis, para permitir desfundir (reverter) uma fusão.
-- Guarda o perfil sobrevivente, o snapshot do perfil descartado e exatamente quais
-- linhas de trilha_perfis/groups pertenciam ao descartado antes da fusão.
CREATE TABLE IF NOT EXISTS public.group_profile_merges (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    survivor_id uuid NOT NULL REFERENCES public.group_profiles (id) ON DELETE CASCADE,
    survivor_nome_anterior text NOT NULL,
    discarded_id uuid NOT NULL,
    discarded_nome text NOT NULL,
    nome_resultante text NOT NULL,
    trilha_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    group_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- Trilhas que tinham os dois perfis: a fusao apagou a linha duplicada, então a
    -- desfusao precisa recriá-la em vez de apenas reapontar profile_id.
    collapsed_trilha_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_group_profile_merges_survivor_id
    ON public.group_profile_merges (survivor_id);

ALTER TABLE public.group_profile_merges ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'group_profile_merges' AND policyname = 'group_profile_merges_select_policy'
    ) THEN
        CREATE POLICY group_profile_merges_select_policy ON public.group_profile_merges
            FOR SELECT
            USING (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'group_profile_merges' AND policyname = 'group_profile_merges_insert_policy'
    ) THEN
        CREATE POLICY group_profile_merges_insert_policy ON public.group_profile_merges
            FOR INSERT
            WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'group_profile_merges' AND policyname = 'group_profile_merges_delete_policy'
    ) THEN
        CREATE POLICY group_profile_merges_delete_policy ON public.group_profile_merges
            FOR DELETE
            USING (true);
    END IF;
END $$;
