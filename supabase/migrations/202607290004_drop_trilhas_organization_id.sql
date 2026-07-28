-- Guarda: aborta se dropar organization_id criaria duplicidade em (macrotema, trilha)
-- que hoje so nao colide por pertencer a organizacoes diferentes.
DO $$
DECLARE
    dupes integer;
BEGIN
    SELECT count(*) INTO dupes FROM (
        SELECT macrotema, trilha, count(*) c
        FROM public.trilhas
        GROUP BY macrotema, trilha
        HAVING count(*) > 1
    ) x;

    IF dupes > 0 THEN
        RAISE EXCEPTION 'trilhas: % combinacao(oes) de macrotema+trilha duplicadas entre organizacoes - resolver manualmente (merge/rename) antes de aplicar esta migration', dupes;
    END IF;
END $$;

ALTER TABLE public.trilhas DROP CONSTRAINT IF EXISTS uq_trilhas_org_macrotema_trilha;
ALTER TABLE public.trilhas ADD CONSTRAINT uq_trilhas_macrotema_trilha UNIQUE (macrotema, trilha);
ALTER TABLE public.trilhas DROP CONSTRAINT IF EXISTS fk_trilhas_organization;
DROP INDEX IF EXISTS idx_trilhas_organization_id;
DROP INDEX IF EXISTS idx_trilhas_macrotema;
ALTER TABLE public.trilhas DROP COLUMN IF EXISTS organization_id;
CREATE INDEX IF NOT EXISTS idx_trilhas_macrotema ON public.trilhas (macrotema);

-- Remove a organizacao sentinela "Trilhas Legadas (revisar organizacao)" SE nada mais
-- depender dela (checagem defensiva - nao remover as cegas se houver outro vinculo).
DO $$
DECLARE
    sentinel_id uuid;
    other_refs integer;
BEGIN
    SELECT id INTO sentinel_id FROM public.organizations WHERE nome = 'Trilhas Legadas (revisar organizacao)';

    IF sentinel_id IS NOT NULL THEN
        SELECT
            (SELECT count(*) FROM public.groups WHERE organization_id = sentinel_id) +
            (SELECT count(*) FROM public.campaign_groups WHERE organization_id = sentinel_id)
        INTO other_refs;

        IF other_refs > 0 THEN
            RAISE WARNING 'Organizacao sentinela ainda referenciada por % linha(s) fora de trilhas - NAO removida automaticamente', other_refs;
        ELSE
            DELETE FROM public.organizations WHERE id = sentinel_id;
        END IF;
    END IF;
END $$;
