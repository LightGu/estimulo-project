-- Renomeada de 202608280001 para 202608280006 em 2026-09-02.
--
-- Nasceu com o mesmo timestamp de 202608280001_fix_organizations_schema_drift,
-- e o historico do Supabase (supabase_migrations.schema_migrations) tem a
-- versao como chave: so um dos dois arquivos cabia la. A versao 202608280001
-- ficou registrada com o nome fix_organizations_schema_drift, e este arquivo
-- ficava eternamente "pendente" - todo `supabase db push` tentava reaplicar e
-- morria no INSERT de chave duplicada, travando TODA migration posterior
-- (202608310001, 202609010001 e 202609020001 ficaram presas atras disso).
--
-- O timestamp novo e' o proximo livre do mesmo dia, entao a ordem de aplicacao
-- nao muda. O conteudo abaixo esta intacto e ja estava aplicado no banco.

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
