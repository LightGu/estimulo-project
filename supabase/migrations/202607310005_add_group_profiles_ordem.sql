-- Ordem de progressao entre perfis (Pré-infância -> Infância -> Adolescência ->
-- Maturidade), usada pelo motor de sequenciamento automatico de trilhas para saber
-- qual e o "proximo perfil" quando a sequencia do perfil atual se esgota (checkpoint
-- de jornada). Perfis sem ordem (ex.: criados manualmente por fusao/necessidade
-- especifica) simplesmente nao participam do avanco automatico entre perfis.
--
-- Sem constraint de unicidade de proposito, pelo mesmo motivo de
-- trilha_perfis.ordem (202607310006): o endpoint de reordenar perfis escreve uma
-- linha por vez, e trocar duas posicoes adjacentes passaria por um estado
-- intermediario com ordem duplicada antes de terminar.
ALTER TABLE public.group_profiles
    ADD COLUMN IF NOT EXISTS ordem integer;

UPDATE public.group_profiles
SET ordem = seed.ordem
FROM (VALUES ('Pré-infância', 1), ('Infância', 2), ('Adolescência', 3), ('Maturidade', 4)) AS seed(nome, ordem)
WHERE group_profiles.nome = seed.nome
  AND group_profiles.ordem IS NULL;
