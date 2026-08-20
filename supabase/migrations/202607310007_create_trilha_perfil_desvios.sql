-- Desvios condicionais por setor: "assim que a trilha after_trilha_id for concluida
-- na sequencia do perfil profile_id, se o setor do grupo combinar com um dos valores
-- em setores, entregue trilha_destino_id antes de seguir para o proximo item da
-- sequencia normal". Ancorado por trilha_id (nao por um inteiro de posicao) para a
-- regra continuar valida mesmo que a sequencia seja reordenada depois -
-- trilha_perfis ja garante UNIQUE(trilha_id, profile_id), entao uma trilha nao se
-- repete dentro da sequencia do mesmo perfil e o anchor e sempre inambiguo.
CREATE TABLE IF NOT EXISTS public.trilha_perfil_desvios (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL,
    after_trilha_id uuid NOT NULL,
    setores jsonb NOT NULL DEFAULT '[]'::jsonb,
    trilha_destino_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_trilha_perfil_desvios_profile
        FOREIGN KEY (profile_id) REFERENCES public.group_profiles(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_trilha_perfil_desvios_after_trilha
        FOREIGN KEY (after_trilha_id) REFERENCES public.trilhas(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_trilha_perfil_desvios_destino
        FOREIGN KEY (trilha_destino_id) REFERENCES public.trilhas(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trilha_perfil_desvios_anchor ON public.trilha_perfil_desvios (profile_id, after_trilha_id);

ALTER TABLE public.trilha_perfil_desvios ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'trilha_perfil_desvios' AND policyname = 'trilha_perfil_desvios_select_policy'
    ) THEN
        CREATE POLICY trilha_perfil_desvios_select_policy ON public.trilha_perfil_desvios
            FOR SELECT
            USING (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'trilha_perfil_desvios' AND policyname = 'trilha_perfil_desvios_insert_policy'
    ) THEN
        CREATE POLICY trilha_perfil_desvios_insert_policy ON public.trilha_perfil_desvios
            FOR INSERT
            WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'trilha_perfil_desvios' AND policyname = 'trilha_perfil_desvios_delete_policy'
    ) THEN
        CREATE POLICY trilha_perfil_desvios_delete_policy ON public.trilha_perfil_desvios
            FOR DELETE
            USING (true);
    END IF;
END $$;
