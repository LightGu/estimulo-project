CREATE TABLE IF NOT EXISTS public.trilha_perfis (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    macrotema text NOT NULL,
    trilha text NOT NULL,
    perfil text NOT NULL CHECK (perfil IN ('Pré-infância', 'Infância', 'Adolescência', 'Maturidade')),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_trilha_perfis UNIQUE (macrotema, trilha, perfil)
);

CREATE INDEX IF NOT EXISTS idx_trilha_perfis_macrotema_trilha ON public.trilha_perfis (macrotema, trilha);

ALTER TABLE public.trilha_perfis ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'trilha_perfis'
          AND policyname = 'trilha_perfis_select_policy'
    ) THEN
        CREATE POLICY trilha_perfis_select_policy ON public.trilha_perfis
            FOR SELECT
            USING (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'trilha_perfis'
          AND policyname = 'trilha_perfis_insert_policy'
    ) THEN
        CREATE POLICY trilha_perfis_insert_policy ON public.trilha_perfis
            FOR INSERT
            WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'trilha_perfis'
          AND policyname = 'trilha_perfis_delete_policy'
    ) THEN
        CREATE POLICY trilha_perfis_delete_policy ON public.trilha_perfis
            FOR DELETE
            USING (true);
    END IF;
END $$;

-- Popula trilha_perfis a partir das combinacoes atuais de perfil_da_jornada em video_catalog,
-- decompondo textos como "Infancia/Adolescencia", "Infancia (setorial)" e "Todos" nos 4 perfis canonicos.
-- translate() remove acentos sem depender da extensao unaccent.
WITH origem AS (
    SELECT DISTINCT macrotema, trilha, perfil_da_jornada
    FROM public.video_catalog
    WHERE macrotema IS NOT NULL
      AND trilha IS NOT NULL
      AND perfil_da_jornada IS NOT NULL
),
normalizado AS (
    SELECT
        macrotema,
        trilha,
        trim(regexp_replace(perfil_da_jornada, '\(setorial\)', '', 'gi')) AS perfil_texto
    FROM origem
),
partes AS (
    SELECT
        macrotema,
        trilha,
        lower(translate(trim(unnest(string_to_array(perfil_texto, '/'))), 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC')) AS parte_normalizada
    FROM normalizado
),
mapeado AS (
    SELECT macrotema, trilha, 'Pré-infância' AS perfil
    FROM partes
    WHERE parte_normalizada IN ('pre-infancia', 'pre infancia', 'todos')

    UNION ALL

    SELECT macrotema, trilha, 'Infância'
    FROM partes
    WHERE parte_normalizada IN ('infancia', 'todos')

    UNION ALL

    SELECT macrotema, trilha, 'Adolescência'
    FROM partes
    WHERE parte_normalizada IN ('adolescencia', 'todos')

    UNION ALL

    SELECT macrotema, trilha, 'Maturidade'
    FROM partes
    WHERE parte_normalizada IN ('maturidade', 'todos')
)
INSERT INTO public.trilha_perfis (macrotema, trilha, perfil)
SELECT DISTINCT macrotema, trilha, perfil
FROM mapeado
ON CONFLICT (macrotema, trilha, perfil) DO NOTHING;
