-- A tela de Organizacoes agora permite excluir uma organizacao individualmente
-- (DELETE /organizations/:id).
--
-- 1) FK groups -> organizations: o banco real tem a constraint com o nome
--    'groups_organization_fk' e ON DELETE RESTRICT (e nao 'fk_groups_organization'
--    com CASCADE, como consta em 202607140001 — a constraint foi renomeada e
--    alterada fora do historico de migrations). Com RESTRICT, apagar uma
--    organizacao que tem grupos falha com erro 23503 e a API responde 500.
--    Trocamos para ON DELETE SET NULL: o grupo permanece e apenas perde o
--    vinculo, ficando disponivel para ser reassociado a outra organizacao.
--    A coluna groups.organization_id ja e nullable desde 202607170003, e o
--    mesmo criterio ja vale para campaign_groups (SET NULL, em 202607240002).
--    Os dois nomes possiveis sao dropados para a migration ser idempotente
--    em bancos que ainda tenham o nome original.
--
-- 2) RLS: organizations foi criada em 202607140001 com RLS habilitado e policies
--    de SELECT, INSERT e UPDATE, mas sem policy de DELETE. O backend usa a
--    service role key (que ignora RLS), entao isso nao quebra a API hoje, mas
--    qualquer client anon apagaria zero linhas em silencio.
ALTER TABLE public.groups
DROP CONSTRAINT IF EXISTS groups_organization_fk;

ALTER TABLE public.groups
DROP CONSTRAINT IF EXISTS fk_groups_organization;

ALTER TABLE public.groups
ADD CONSTRAINT groups_organization_fk
    FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'organizations' AND policyname = 'orgs_delete_policy'
    ) THEN
        CREATE POLICY orgs_delete_policy ON public.organizations
            FOR DELETE
            USING (true);
    END IF;
END $$;
