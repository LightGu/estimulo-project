-- Corrige o erro recorrente de dispatch:
--   duplicate key value violates unique constraint "video_captions_pkey"
--
-- CAUSA RAIZ (verificada no banco em 30/07): a primary key da tabela estava na
-- coluna ERRADA.
--
--   video_captions_pkey PRIMARY KEY (video_id)   <-- deveria ser (id)
--
-- Com a PK em video_id a tabela aceita apenas UMA legenda por video, e a
-- segunda legenda de qualquer video falha com violacao de unicidade. O nome
-- "video_captions_pkey" enganava: o indice por tras dele era btree (video_id).
--
-- Isso contradiz o proposito da tabela. video-captions.repository.js
-- (listUnusedTodayByVideo) seleciona ENTRE VARIAS legendas do mesmo video,
-- ordenando por ultimo_uso_em para rotacionar qual sera usada no dia. Com a PK
-- em video_id essa rotacao nunca pode existir.
--
-- Origem: a migration 202607210003 tentou promover idx_video_captions_id a
-- primary key, mas o bloco DO $$ so criava a constraint se NAO existisse
-- nenhuma PK (contype='p'). Como a tabela ja tinha uma PK em video_id, o bloco
-- foi silenciosamente ignorado e o indice unico idx_video_captions_id ficou
-- orfao, sem nunca virar a primary key.
--
-- Pre-condicoes confirmadas antes de aplicar: 19 linhas, 19 ids distintos,
-- 0 ids nulos, nenhum video com mais de 1 legenda.

-- 1. Remove a PK incorreta em video_id. A FK fk_video_captions_video (que
--    aponta video_captions.video_id -> video_catalog.id) nao depende desta PK e
--    permanece intacta.
ALTER TABLE public.video_captions
    DROP CONSTRAINT IF EXISTS video_captions_pkey;

-- 2. Garante o indice unico sobre id e promove-o a primary key. Ao usar USING
--    INDEX o Postgres renomeia idx_video_captions_id para video_captions_pkey,
--    entao o nome da constraint volta a ser o esperado — agora apontando para a
--    coluna certa.
CREATE UNIQUE INDEX IF NOT EXISTS idx_video_captions_id
    ON public.video_captions (id);

ALTER TABLE public.video_captions
    ALTER COLUMN id SET NOT NULL;

ALTER TABLE public.video_captions
    ADD CONSTRAINT video_captions_pkey PRIMARY KEY USING INDEX idx_video_captions_id;

-- 3. Reafirma o default (idempotente; ja estava correto no banco atual).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.video_captions
    ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- 4. Recria o indice de rotacao por video. Com a PK antiga em video_id ele era
--    redundante; agora e ele que sustenta a busca de legenda nao usada no dia.
CREATE INDEX IF NOT EXISTS idx_video_captions_video_ultimo_uso
    ON public.video_captions (video_id, ultimo_uso_em);
