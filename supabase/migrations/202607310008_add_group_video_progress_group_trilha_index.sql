-- hasGroupReceivedTrilha (motor de sequenciamento automatico) consulta por
-- (group_id, trilha_id) a cada tick de disparo para cada grupo; so havia indice
-- em trilha_id isolado.
CREATE INDEX IF NOT EXISTS idx_group_video_progress_group_id_trilha_id
    ON public.group_video_progress (group_id, trilha_id);
