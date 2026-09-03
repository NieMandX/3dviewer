-- The 2GIS key is a backend-only secret. Browsers can manage it only through
-- the authenticated application service, which rechecks is_superuser().
create table if not exists public.integration_secrets (
    name text primary key,
    secret_value text not null,
    updated_at timestamptz not null default now(),
    updated_by uuid references auth.users(id) on delete set null,
    constraint integration_secrets_name_format check (name ~ '^[a-z0-9_]{1,64}$'),
    constraint integration_secrets_value_size check (char_length(secret_value) between 1 and 4096)
);

alter table public.integration_secrets enable row level security;
alter table public.integration_secrets force row level security;

revoke all on table public.integration_secrets from public, anon, authenticated;
grant select, insert, update, delete on table public.integration_secrets to service_role;

comment on table public.integration_secrets is
    'Backend-only integration credentials. Never select this table from viewer code.';

notify pgrst, 'reload schema';
