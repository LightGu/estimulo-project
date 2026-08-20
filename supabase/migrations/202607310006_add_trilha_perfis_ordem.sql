-- Posicao da trilha dentro da sequencia daquele perfil. Cada linha de trilha_perfis
-- e um par (trilha, perfil), entao a mesma trilha pode ter ordem diferente em
-- perfis diferentes sem conflito (ex.: "4.2 Digital na Prática" repete em mais de
-- uma jornada). Sem constraint de unicidade em (profile_id, ordem) de proposito -
-- o endpoint de reordenar escreve uma linha por vez (mesmo padrao ja usado em
-- trilha_videos.ordem/reorderVideosWithinTrilha) e um estado intermediario da troca
-- de posicoes violaria uma unique constraint antes de terminar.
ALTER TABLE public.trilha_perfis
    ADD COLUMN IF NOT EXISTS ordem integer;

WITH numerado AS (
    SELECT id, row_number() OVER (PARTITION BY profile_id ORDER BY created_at, id) AS rn
    FROM public.trilha_perfis
    WHERE ordem IS NULL
)
UPDATE public.trilha_perfis AS tp
SET ordem = numerado.rn
FROM numerado
WHERE tp.id = numerado.id;

ALTER TABLE public.trilha_perfis
    ALTER COLUMN ordem SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trilha_perfis_profile_id_ordem ON public.trilha_perfis (profile_id, ordem);
