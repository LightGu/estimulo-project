-- A producao tem a coluna criada como "description" (ingles), mas o codigo
-- inteiro (services/repositories/controllers/frontend) sempre leu/escreveu
-- "descricao" (portugues), igual ao resto do schema (nome, programa,
-- segmento...). A migration 202607230001_add_organizations_descricao_programa
-- ja assumia "descricao" desde o inicio - "description" parece ter sido criada
-- manualmente, fora do fluxo normal de migrations, e nunca corrigida.
--
-- Efeito prático: toda edicao de organizacao que passasse por "descricao" (ou
-- seja, qualquer PATCH feito pela tela de Organizacoes, que sempre envia esse
-- campo, mesmo vazio) quebrava com PGRST204 "Could not find the 'descricao'
-- column" - incluindo renomear, que so muda o nome mas ainda manda o payload
-- inteiro.
ALTER TABLE public.organizations
    RENAME COLUMN description TO descricao;
