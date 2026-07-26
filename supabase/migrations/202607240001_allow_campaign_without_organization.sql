ALTER TABLE public.campaigns
ALTER COLUMN organization_id DROP NOT NULL;

ALTER TABLE public.campaigns
DROP CONSTRAINT IF EXISTS fk_campaigns_organization;

ALTER TABLE public.campaigns
ADD CONSTRAINT fk_campaigns_organization
    FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE;
