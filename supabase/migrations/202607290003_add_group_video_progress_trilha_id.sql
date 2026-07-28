ALTER TABLE public.group_video_progress
    ADD COLUMN IF NOT EXISTS trilha_id uuid;

ALTER TABLE public.group_video_progress
    ADD CONSTRAINT fk_group_video_progress_trilha
        FOREIGN KEY (trilha_id)
        REFERENCES public.trilhas(id)
        ON DELETE SET NULL
        ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS idx_group_video_progress_trilha_id ON public.group_video_progress (trilha_id);

-- Sem backfill: registros existentes nao tem como saber com certeza de qual trilha
-- vieram (um video pode pertencer a N trilhas via trilha_videos). Ficam com trilha_id
-- NULL (historico pre-migracao); a partir do proximo dispatch, cada novo registro grava
-- o trilha_id resolvido no momento do envio.
