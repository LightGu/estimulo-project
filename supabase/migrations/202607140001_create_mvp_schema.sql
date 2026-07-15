CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.organizations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nome text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.groups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    nome text NOT NULL,
    evolution_group_id text NOT NULL UNIQUE,
    segmento text NOT NULL,
    maturidade smallint NOT NULL CHECK (maturidade BETWEEN 1 AND 4),
    trilha_override text,
    envia_video boolean NOT NULL DEFAULT true,
    last_message_sent_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_groups_organization
        FOREIGN KEY (organization_id)
        REFERENCES public.organizations(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS public.video_catalog (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    drive_file_id text NOT NULL UNIQUE,
    etapa integer NOT NULL CHECK (etapa >= 1),
    trilha_segmento text NOT NULL,
    genero_conteudo text NOT NULL,
    status text NOT NULL DEFAULT 'pendente_revisao' CHECK (
        status IN ('pendente_revisao', 'aprovado', 'reprovado', 'inativo')
    ),
    data_aprovacao timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_video_catalog_approval
        CHECK (
            (status = 'aprovado' AND data_aprovacao IS NOT NULL)
            OR (status <> 'aprovado')
        )
);

CREATE TABLE IF NOT EXISTS public.campaigns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    nome text NOT NULL,
    cron_expression text NOT NULL,
    ativo boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_campaigns_organization
        FOREIGN KEY (organization_id)
        REFERENCES public.organizations(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS public.campaign_groups (
    campaign_id uuid NOT NULL,
    group_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (campaign_id, group_id),
    CONSTRAINT fk_campaign_groups_campaign
        FOREIGN KEY (campaign_id)
        REFERENCES public.campaigns(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT fk_campaign_groups_group
        FOREIGN KEY (group_id)
        REFERENCES public.groups(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS public.group_video_progress (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id uuid NOT NULL,
    video_id uuid NOT NULL,
    enviado_em timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_group_video_progress_group
        FOREIGN KEY (group_id)
        REFERENCES public.groups(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT fk_group_video_progress_video
        FOREIGN KEY (video_id)
        REFERENCES public.video_catalog(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT uq_group_video_progress UNIQUE (group_id, video_id)
);

CREATE TABLE IF NOT EXISTS public.dispatch_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id uuid NOT NULL,
    group_id uuid NOT NULL,
    video_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'pendente' CHECK (
        status IN ('pendente', 'processando', 'enviado', 'falhou')
    ),
    mensagem_erro text,
    criado_em timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_dispatch_logs_campaign
        FOREIGN KEY (campaign_id)
        REFERENCES public.campaigns(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT fk_dispatch_logs_group
        FOREIGN KEY (group_id)
        REFERENCES public.groups(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT fk_dispatch_logs_video
        FOREIGN KEY (video_id)
        REFERENCES public.video_catalog(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'trg_organizations_updated_at'
    ) THEN
        CREATE TRIGGER trg_organizations_updated_at
        BEFORE UPDATE ON public.organizations
        FOR EACH ROW
        EXECUTE FUNCTION public.set_updated_at();
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'trg_groups_updated_at'
    ) THEN
        CREATE TRIGGER trg_groups_updated_at
        BEFORE UPDATE ON public.groups
        FOR EACH ROW
        EXECUTE FUNCTION public.set_updated_at();
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'trg_video_catalog_updated_at'
    ) THEN
        CREATE TRIGGER trg_video_catalog_updated_at
        BEFORE UPDATE ON public.video_catalog
        FOR EACH ROW
        EXECUTE FUNCTION public.set_updated_at();
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'trg_campaigns_updated_at'
    ) THEN
        CREATE TRIGGER trg_campaigns_updated_at
        BEFORE UPDATE ON public.campaigns
        FOR EACH ROW
        EXECUTE FUNCTION public.set_updated_at();
    END IF;
END $$;

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_video_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispatch_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'organizations'
          AND policyname = 'orgs_select_policy'
    ) THEN
        CREATE POLICY orgs_select_policy ON public.organizations
            FOR SELECT
            USING (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'organizations'
          AND policyname = 'orgs_insert_policy'
    ) THEN
        CREATE POLICY orgs_insert_policy ON public.organizations
            FOR INSERT
            WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'organizations'
          AND policyname = 'orgs_update_policy'
    ) THEN
        CREATE POLICY orgs_update_policy ON public.organizations
            FOR UPDATE
            USING (true)
            WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'groups'
          AND policyname = 'groups_select_policy'
    ) THEN
        CREATE POLICY groups_select_policy ON public.groups
            FOR SELECT
            USING (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'groups'
          AND policyname = 'groups_insert_policy'
    ) THEN
        CREATE POLICY groups_insert_policy ON public.groups
            FOR INSERT
            WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'groups'
          AND policyname = 'groups_update_policy'
    ) THEN
        CREATE POLICY groups_update_policy ON public.groups
            FOR UPDATE
            USING (true)
            WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'campaigns'
          AND policyname = 'campaigns_select_policy'
    ) THEN
        CREATE POLICY campaigns_select_policy ON public.campaigns
            FOR SELECT
            USING (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'campaigns'
          AND policyname = 'campaigns_insert_policy'
    ) THEN
        CREATE POLICY campaigns_insert_policy ON public.campaigns
            FOR INSERT
            WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'campaigns'
          AND policyname = 'campaigns_update_policy'
    ) THEN
        CREATE POLICY campaigns_update_policy ON public.campaigns
            FOR UPDATE
            USING (true)
            WITH CHECK (true);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_groups_organization_id ON public.groups (organization_id);
CREATE INDEX IF NOT EXISTS idx_groups_segmento ON public.groups (segmento);
CREATE INDEX IF NOT EXISTS idx_campaigns_organization_id ON public.campaigns (organization_id);
CREATE INDEX IF NOT EXISTS idx_campaign_groups_group_id ON public.campaign_groups (group_id);
CREATE INDEX IF NOT EXISTS idx_group_video_progress_group_id ON public.group_video_progress (group_id);
CREATE INDEX IF NOT EXISTS idx_group_video_progress_video_id ON public.group_video_progress (video_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_logs_campaign_id ON public.dispatch_logs (campaign_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_logs_group_id ON public.dispatch_logs (group_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_logs_criado_em ON public.dispatch_logs (criado_em);
CREATE INDEX IF NOT EXISTS idx_video_catalog_trilha_status_etapa ON public.video_catalog (trilha_segmento, status, etapa);
CREATE INDEX IF NOT EXISTS idx_dispatch_logs_campaign_group_created ON public.dispatch_logs (campaign_id, group_id, criado_em);
