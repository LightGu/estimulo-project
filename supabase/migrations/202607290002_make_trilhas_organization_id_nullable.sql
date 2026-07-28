-- Passo intermediario seguro rumo a remover o vinculo entre trilhas e organizations:
-- trilha e conteudo compartilhavel entre organizacoes, nao deveria pertencer a uma so.
-- A remocao definitiva da coluna (e da organizacao sentinela "Trilhas Legadas") fica
-- para uma migracao futura, depois que trilhas.repository/service/controller.js e a
-- tela trilhas.html pararem de filtrar por organization_id.
ALTER TABLE public.trilhas ALTER COLUMN organization_id DROP NOT NULL;
