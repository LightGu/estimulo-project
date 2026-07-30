-- Correcao (segunda causa do 500 ao renomear perfil):
-- trilha_perfis.perfil tinha uma FK para group_profiles(nome) com ON UPDATE NO ACTION.
-- Como a referencia era o proprio texto do nome, renomear um perfil usado por qualquer
-- trilha violava a constraint antes mesmo do trigger de sincronia rodar (AFTER UPDATE),
-- e a API respondia "Internal server error".
--
-- O vinculo relacional agora e trilha_perfis.profile_id -> group_profiles(id)
-- (fk_trilha_perfis_profile_id, criada em 202607300001), então a FK textual e redundante.
-- A coluna perfil continua existindo e sincronizada por trigger para nao quebrar
-- leituras legadas — apenas deixa de ser uma FK.
ALTER TABLE public.trilha_perfis
    DROP CONSTRAINT IF EXISTS fk_trilha_perfis_group_profiles;
