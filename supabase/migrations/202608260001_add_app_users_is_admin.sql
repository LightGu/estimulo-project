alter table app_users add column if not exists is_admin boolean not null default false;

comment on column app_users.is_admin is
  'Marca contas com permissao para criar e (des)ativar outros logins do painel. Substitui a antiga senha mestra compartilhada (ESTIMULO_ADMIN_MASTER_PASSWORD), que deixou de existir.';

-- Bootstrap: as duas contas que ja administravam os logins do painel via
-- senha mestra viram admins nomeados.
update app_users set is_admin = true where username in ('lina.ussami@estimulo.org', 'gustavoluz');
