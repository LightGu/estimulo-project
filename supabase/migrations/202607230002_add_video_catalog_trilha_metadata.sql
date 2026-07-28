ALTER TABLE public.video_catalog
    ADD COLUMN IF NOT EXISTS perfil_da_jornada text,
    ADD COLUMN IF NOT EXISTS macrotema text,
    ADD COLUMN IF NOT EXISTS trilha text,
    ADD COLUMN IF NOT EXISTS ordem integer,
    ADD COLUMN IF NOT EXISTS nome_do_arquivo text,
    ADD COLUMN IF NOT EXISTS pasta_atual text,
    ADD COLUMN IF NOT EXISTS objetivo_de_aprendizagem text,
    ADD COLUMN IF NOT EXISTS nivel text,
    ADD COLUMN IF NOT EXISTS observacoes text;

CREATE INDEX IF NOT EXISTS idx_video_catalog_perfil_macrotema_trilha
    ON public.video_catalog (perfil_da_jornada, macrotema, trilha, ordem_geral);
