create extension if not exists pgcrypto;

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);

comment on table app_users is
  'Logins do painel administrativo. Sem policies de RLS: apenas a service_role key (usada pelo backend) acessa esta tabela, entao o anon key nunca enxerga usuarios ou hashes de senha.';

alter table app_users enable row level security;

create or replace function set_app_users_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists app_users_set_updated_at on app_users;

create trigger app_users_set_updated_at
  before update on app_users
  for each row
  execute function set_app_users_updated_at();
