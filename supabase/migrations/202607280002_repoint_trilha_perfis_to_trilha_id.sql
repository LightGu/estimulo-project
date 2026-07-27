ALTER TABLE public.trilha_perfis
    ADD COLUMN IF NOT EXISTS trilha_id uuid;

UPDATE public.trilha_perfis AS tp
SET trilha_id = t.id
FROM public.trilhas AS t
WHERE t.macrotema = tp.macrotema
  AND t.trilha = tp.trilha
  AND tp.trilha_id IS NULL;

DO $$
DECLARE
    orfaos integer;
BEGIN
    SELECT count(*) INTO orfaos FROM public.trilha_perfis WHERE trilha_id IS NULL;
    IF orfaos > 0 THEN
        RAISE WARNING 'trilha_perfis: % linha(s) sem trilha_id correspondente apos migracao', orfaos;
    END IF;
END $$;

ALTER TABLE public.trilha_perfis
    ADD CONSTRAINT fk_trilha_perfis_trilha
        FOREIGN KEY (trilha_id)
        REFERENCES public.trilhas(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE;

ALTER TABLE public.trilha_perfis DROP CONSTRAINT IF EXISTS uq_trilha_perfis;
ALTER TABLE public.trilha_perfis
    ADD CONSTRAINT uq_trilha_perfis_v2 UNIQUE (trilha_id, perfil);

CREATE INDEX IF NOT EXISTS idx_trilha_perfis_trilha_id ON public.trilha_perfis (trilha_id);

-- Colunas legadas macrotema/trilha em trilha_perfis sao mantidas por 1 ciclo (nao removidas
-- nesta migration), apenas deixam de ser a chave de identificacao da trilha.
