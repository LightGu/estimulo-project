-- Backfill de groups.profile_id: a coluna existe desde 202607300001_add_profile_id_fk,
-- mas a API/UI nunca escreveu nela - so escrevia groups.segmento como texto livre.
-- Sem profile_id populado, o motor de sequenciamento automatico de trilhas nao
-- consegue identificar com seguranca o perfil do grupo (segmento tem grafias
-- divergentes do nome canonico em group_profiles, ex.: "Pré-Infância" vs
-- "Pré-infância", "Adolescente" vs "Adolescência").
--
-- translate() remove acentos sem depender da extensao unaccent (mesmo padrao usado
-- em 202607260001_create_trilha_perfis.sql). "Adolescente" e uma grafia legada
-- distinta o suficiente de "Adolescência" para nao casar so com o accent-fold,
-- entao entra como alias explicito.
WITH alias AS (
    SELECT 'adolescente' AS de, 'adolescencia' AS para
)
UPDATE public.groups AS g
SET profile_id = gp.id
FROM public.group_profiles AS gp
WHERE g.profile_id IS NULL
  AND g.segmento IS NOT NULL
  AND (
    lower(translate(g.segmento, 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'))
      = lower(translate(gp.nome, 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'))
    OR lower(translate(g.segmento, 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'))
      = (
          SELECT alias.de FROM alias
          WHERE alias.para = lower(translate(gp.nome, 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'))
        )
  );

DO $$
DECLARE
    orfaos integer;
BEGIN
    SELECT count(*) INTO orfaos
    FROM public.groups
    WHERE profile_id IS NULL AND segmento IS NOT NULL;

    IF orfaos > 0 THEN
        RAISE WARNING 'groups: % linha(s) com segmento definido mas sem profile_id correspondente apos backfill - revisar manualmente (grafia de segmento sem perfil canonico correspondente)', orfaos;
    END IF;
END $$;
