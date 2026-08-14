-- Backfill de trilha_perfis.profile_id: a migration 202607300001_add_profile_id_fk
-- populou profile_id uma unica vez, mas trilhas.repository.js#setTrailPerfis (usada
-- sempre que alguem marca os perfis de uma trilha em trilhas.html) so gravava a
-- coluna de texto legada `perfil`, nunca `profile_id` - qualquer trilha criada ou
-- reperfilada depois daquela migration ficou com profile_id nulo. Corrigido em
-- trilhas.repository.js na mesma leva desta migration; aqui so re-sincroniza o que
-- ja ficou orfao.
UPDATE public.trilha_perfis AS tp
SET profile_id = gp.id
FROM public.group_profiles AS gp
WHERE tp.profile_id IS NULL
  AND tp.perfil IS NOT NULL
  AND lower(translate(tp.perfil, 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'))
    = lower(translate(gp.nome, 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'));

DO $$
DECLARE
    orfaos integer;
BEGIN
    SELECT count(*) INTO orfaos
    FROM public.trilha_perfis
    WHERE profile_id IS NULL AND perfil IS NOT NULL;

    IF orfaos > 0 THEN
        RAISE WARNING 'trilha_perfis: % linha(s) com perfil definido mas sem profile_id correspondente apos backfill', orfaos;
    END IF;
END $$;
