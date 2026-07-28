ALTER TABLE public.groups
    ADD COLUMN IF NOT EXISTS trilha_id uuid;

-- Backfill por match textual exato contra trilhas.trilha (mesmo padrao usado em
-- 202607280002 para trilha_perfis). So aplica quando o nome da trilha e unico entre
-- todas as trilhas cadastradas, para evitar vincular um grupo a trilha errada quando
-- o mesmo nome existir em mais de um macrotema.
DO $$
DECLARE
    ambiguous integer;
BEGIN
    SELECT count(*) INTO ambiguous
    FROM public.groups g
    WHERE g.trilha_override IS NOT NULL
      AND (SELECT count(*) FROM public.trilhas t WHERE t.trilha = g.trilha_override) > 1;

    IF ambiguous > 0 THEN
        RAISE WARNING 'groups.trilha_override: % linha(s) com nome de trilha ambiguo (existe em mais de um macrotema) - backfill vai pular essas linhas', ambiguous;
    END IF;
END $$;

UPDATE public.groups AS g
SET trilha_id = t.id
FROM public.trilhas AS t
WHERE t.trilha = g.trilha_override
  AND g.trilha_id IS NULL
  AND (SELECT count(*) FROM public.trilhas t2 WHERE t2.trilha = g.trilha_override) = 1;

DO $$
DECLARE
    orfaos integer;
BEGIN
    SELECT count(*) INTO orfaos
    FROM public.groups
    WHERE trilha_override IS NOT NULL AND trilha_id IS NULL;

    IF orfaos > 0 THEN
        RAISE WARNING 'groups: % linha(s) com trilha_override sem trilha_id correspondente (nome nao encontrado ou ambiguo) apos backfill', orfaos;
    END IF;
END $$;

ALTER TABLE public.groups
    ADD CONSTRAINT fk_groups_trilha
        FOREIGN KEY (trilha_id)
        REFERENCES public.trilhas(id)
        ON DELETE SET NULL
        ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS idx_groups_trilha_id ON public.groups (trilha_id);

-- trilha_override e mantida por 1 ciclo (mesmo padrao ja usado para
-- trilha_perfis.macrotema/trilha em 202607280002/202607280003), continua sendo lida
-- e escrita pelo codigo atual ate o fluxo de disparo ser totalmente migrado para trilha_id.
