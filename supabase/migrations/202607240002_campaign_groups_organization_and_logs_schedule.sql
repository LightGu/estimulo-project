ALTER TABLE public.campaigns
DROP CONSTRAINT IF EXISTS fk_campaigns_organization;

DROP INDEX IF EXISTS idx_campaigns_organization_id;

ALTER TABLE public.campaigns
DROP COLUMN IF EXISTS organization_id;

ALTER TABLE public.campaign_groups
ADD COLUMN IF NOT EXISTS organization_id uuid;

UPDATE public.campaign_groups cg
SET organization_id = g.organization_id
FROM public.groups g
WHERE cg.group_id = g.id
    AND cg.organization_id IS NULL;

ALTER TABLE public.campaign_groups
ADD CONSTRAINT fk_campaign_groups_organization
    FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS idx_campaign_groups_organization_id ON public.campaign_groups (organization_id);

ALTER TABLE public.logs
ADD COLUMN IF NOT EXISTS horario_envio_planejado timestamptz;
