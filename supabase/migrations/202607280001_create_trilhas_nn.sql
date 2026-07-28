CREATE TABLE IF NOT EXISTS public.trilhas (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    macrotema text NOT NULL,
    trilha text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_trilhas_organization
        FOREIGN KEY (organization_id)
        REFERENCES public.organizations(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT uq_trilhas_org_macrotema_trilha UNIQUE (organization_id, macrotema, trilha)
);

CREATE INDEX IF NOT EXISTS idx_trilhas_organization_id ON public.trilhas (organization_id);
CREATE INDEX IF NOT EXISTS idx_trilhas_macrotema ON public.trilhas (organization_id, macrotema);

CREATE TABLE IF NOT EXISTS public.trilha_videos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    trilha_id uuid NOT NULL,
    video_id uuid NOT NULL,
    ordem integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_trilha_videos_trilha
        FOREIGN KEY (trilha_id)
        REFERENCES public.trilhas(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT fk_trilha_videos_video
        FOREIGN KEY (video_id)
        REFERENCES public.video_catalog(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT uq_trilha_videos UNIQUE (trilha_id, video_id)
);

CREATE INDEX IF NOT EXISTS idx_trilha_videos_trilha_id ON public.trilha_videos (trilha_id, ordem);
CREATE INDEX IF NOT EXISTS idx_trilha_videos_video_id ON public.trilha_videos (video_id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'trg_trilhas_updated_at'
    ) THEN
        CREATE TRIGGER trg_trilhas_updated_at
        BEFORE UPDATE ON public.trilhas
        FOR EACH ROW
        EXECUTE FUNCTION public.set_updated_at();
    END IF;
END $$;

ALTER TABLE public.trilhas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trilha_videos ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'trilhas' AND policyname = 'trilhas_select_policy'
    ) THEN
        CREATE POLICY trilhas_select_policy ON public.trilhas
            FOR SELECT
            USING (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'trilhas' AND policyname = 'trilhas_insert_policy'
    ) THEN
        CREATE POLICY trilhas_insert_policy ON public.trilhas
            FOR INSERT
            WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'trilhas' AND policyname = 'trilhas_update_policy'
    ) THEN
        CREATE POLICY trilhas_update_policy ON public.trilhas
            FOR UPDATE
            USING (true)
            WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'trilhas' AND policyname = 'trilhas_delete_policy'
    ) THEN
        CREATE POLICY trilhas_delete_policy ON public.trilhas
            FOR DELETE
            USING (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'trilha_videos' AND policyname = 'trilha_videos_select_policy'
    ) THEN
        CREATE POLICY trilha_videos_select_policy ON public.trilha_videos
            FOR SELECT
            USING (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'trilha_videos' AND policyname = 'trilha_videos_insert_policy'
    ) THEN
        CREATE POLICY trilha_videos_insert_policy ON public.trilha_videos
            FOR INSERT
            WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'trilha_videos' AND policyname = 'trilha_videos_update_policy'
    ) THEN
        CREATE POLICY trilha_videos_update_policy ON public.trilha_videos
            FOR UPDATE
            USING (true)
            WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'trilha_videos' AND policyname = 'trilha_videos_delete_policy'
    ) THEN
        CREATE POLICY trilha_videos_delete_policy ON public.trilha_videos
            FOR DELETE
            USING (true);
    END IF;
END $$;

-- Migracao de dados: preserva 100% do estado atual de video_catalog.macrotema/trilha,
-- apontando as trilhas legadas para uma organizacao sentinela ate que sejam
-- reatribuidas manualmente a organizacao correta.
INSERT INTO public.organizations (nome)
SELECT 'Trilhas Legadas (revisar organizacao)'
WHERE NOT EXISTS (
    SELECT 1 FROM public.organizations WHERE nome = 'Trilhas Legadas (revisar organizacao)'
);

INSERT INTO public.trilhas (organization_id, macrotema, trilha)
SELECT
    (SELECT id FROM public.organizations WHERE nome = 'Trilhas Legadas (revisar organizacao)'),
    vc.macrotema,
    vc.trilha
FROM (
    SELECT DISTINCT macrotema, trilha
    FROM public.video_catalog
    WHERE macrotema IS NOT NULL
      AND trilha IS NOT NULL
) AS vc
ON CONFLICT (organization_id, macrotema, trilha) DO NOTHING;

INSERT INTO public.trilha_videos (trilha_id, video_id, ordem)
SELECT
    t.id,
    vc.id,
    coalesce(vc.ordem, vc.ordem_geral, 0)
FROM public.video_catalog AS vc
JOIN public.trilhas AS t
    ON t.macrotema = vc.macrotema
   AND t.trilha = vc.trilha
   AND t.organization_id = (SELECT id FROM public.organizations WHERE nome = 'Trilhas Legadas (revisar organizacao)')
WHERE vc.macrotema IS NOT NULL
  AND vc.trilha IS NOT NULL
ON CONFLICT (trilha_id, video_id) DO NOTHING;
