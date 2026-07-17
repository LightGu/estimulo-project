ALTER TABLE public.video_catalog
    ADD COLUMN IF NOT EXISTS ordem_geral integer;

WITH ordered_videos AS (
    SELECT
        id,
        row_number() OVER (
            PARTITION BY perfil_da_jornada
            ORDER BY trilha ASC NULLS LAST,
                     ordem ASC NULLS LAST,
                     nome_do_arquivo ASC NULLS LAST,
                     id ASC
        ) AS next_ordem_geral
    FROM public.video_catalog
)
UPDATE public.video_catalog AS video
SET ordem_geral = ordered_videos.next_ordem_geral
FROM ordered_videos
WHERE video.id = ordered_videos.id;

ALTER TABLE public.video_catalog
    ALTER COLUMN ordem_geral SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_video_catalog_perfil_ordem_geral
    ON public.video_catalog (perfil_da_jornada, ordem_geral);
