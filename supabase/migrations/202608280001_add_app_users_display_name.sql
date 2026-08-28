-- Nome exibido no canto superior direito do painel (user-chip). Ate agora
-- esse nome vinha de settings.profile_name, uma linha GLOBAL unica - qualquer
-- pessoa logada via, e mudar afetava a sessao de todo mundo ao mesmo tempo.
-- Cada app_user passa a ter o proprio nome de exibicao.
ALTER TABLE public.app_users
    ADD COLUMN IF NOT EXISTS display_name text;

-- Backfill: usa o username atual como nome inicial, para nao aparecer em
-- branco pra quem ja tinha conta antes desta migration.
UPDATE public.app_users
SET display_name = username
WHERE display_name IS NULL;
