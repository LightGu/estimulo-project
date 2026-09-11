-- Grupos duplicados de verdade no WhatsApp (mesmo nome, JID diferente) ja
-- receberam disparo real dos dois lados, entao nao da mais para resolver
-- apagando o menor sem perder historico. Este campo permite tirar um grupo de
-- circulacao para disparos NOVOS (pontual e futuras campanhas) sem apagar a
-- linha nem o historico em `logs`/`campaign_groups`.
ALTER TABLE public.groups
    ADD COLUMN IF NOT EXISTS ativo boolean NOT NULL DEFAULT true;
