-- Editar uma organizacao (PATCH /organizations/:id) sempre falhava com 500.
--
-- Causa: o banco real de organizations diverge do que 202607140001 e
-- 202607230001 registram no historico de migrations (mesmo tipo de drift ja
-- visto em 202607310001 com a FK de groups):
--   1) A coluna e' 'description', nao 'descricao' - 202607230001 nunca rodou
--      de fato contra este banco, so ficou registrada no historico.
--   2) A coluna 'updated_at' nao existe, mas o trigger trg_organizations_updated_at
--      (criado em 202607140001) roda BEFORE UPDATE e tenta gravar nela via
--      set_updated_at(), o que derruba QUALQUER update na tabela com
--      'record "new" has no field "updated_at"'.
--
-- O codigo (repository/service/front-end) sempre usou 'descricao', entao
-- corrigimos o schema para bater com o codigo em vez do contrario.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'description'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'descricao'
    ) THEN
        ALTER TABLE public.organizations RENAME COLUMN description TO descricao;
    END IF;
END $$;

ALTER TABLE public.organizations
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
