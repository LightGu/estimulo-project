-- video_catalog.macrotema/trilha/ordem/perfil_da_jornada sao dados legados: ja
-- espelhados em trilha_videos (video_id+trilha_id+ordem) e trilha_perfis
-- (trilha_id+perfil) desde o backfill em 202607260001/202607280001. Nenhum sync
-- (Google Drive) ou controller ativo escreve nessas colunas. video_catalog.ordem_geral
-- NAO e afetada por esta migration - continua a ordenacao primaria fora do contexto de
-- uma trilha especifica.
DO $$
DECLARE
    orfaos integer;
BEGIN
    SELECT count(*) INTO orfaos
    FROM public.video_catalog vc
    WHERE (vc.macrotema IS NOT NULL OR vc.trilha IS NOT NULL OR vc.ordem IS NOT NULL OR vc.perfil_da_jornada IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM public.trilha_videos tv WHERE tv.video_id = vc.id);

    IF orfaos > 0 THEN
        RAISE EXCEPTION 'video_catalog: % linha(s) com dado legado de trilha sem vinculo correspondente em trilha_videos - resolver manualmente antes de aplicar esta migration', orfaos;
    END IF;
END $$;

ALTER TABLE public.video_catalog DROP COLUMN IF EXISTS macrotema;
ALTER TABLE public.video_catalog DROP COLUMN IF EXISTS trilha;
ALTER TABLE public.video_catalog DROP COLUMN IF EXISTS ordem;
ALTER TABLE public.video_catalog DROP COLUMN IF EXISTS perfil_da_jornada;
