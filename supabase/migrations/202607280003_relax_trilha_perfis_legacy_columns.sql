-- A migration 202607280002 repontou trilha_perfis para trilha_id, mas as colunas legadas
-- macrotema/trilha continuavam NOT NULL, impedindo o insercao de perfis para trilhas novas
-- (que nao preenchem mais essas colunas texto). Relaxa a constraint mantendo as colunas
-- por compatibilidade de leitura ate a limpeza futura (ver plano de trilhas N:N).
ALTER TABLE public.trilha_perfis ALTER COLUMN macrotema DROP NOT NULL;
ALTER TABLE public.trilha_perfis ALTER COLUMN trilha DROP NOT NULL;
