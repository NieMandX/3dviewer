-- Supabase schema for projects, rooms, models, cameras, annotations, and chat.
-- WARNING: This file resets related objects (drops tables/functions) before creating them.
-- Run in Supabase SQL editor.

-- Reset existing schema objects (destructive).
drop table if exists public.room_transitions cascade;
drop table if exists public.room_cameras cascade;
drop table if exists public.room_models cascade;
drop table if exists public.messages cascade;
drop table if exists public.annotations cascade;
drop table if exists public.room_members cascade;
drop table if exists public.room_invites cascade;
drop table if exists public.rooms cascade;
drop table if exists public.project_models cascade;
drop table if exists public.project_members cascade;
drop table if exists public.projects cascade;
drop table if exists public.profiles cascade;
drop table if exists public.user_roles cascade;
drop table if exists public.integration_secrets cascade;

drop function if exists public.release_camera(uuid);
drop function if exists public.claim_camera(uuid);
drop function if exists public.join_room_by_invite(text);
drop function if exists public.ensure_room_invite(uuid);
drop function if exists public.join_project_by_slug(text);
drop function if exists public.join_project_by_slug(text, text);
drop function if exists public.can_access_model_storage_object(text);
drop function if exists public.can_upload_model_storage_object(text);
drop function if exists public.can_manage_room_models(uuid, uuid);
drop function if exists public.can_access_project_model(uuid, uuid);
drop function if exists public.can_access_project(uuid);
drop function if exists public.can_access_room(uuid);
drop function if exists public.is_room_owner(uuid);
drop function if exists public.is_project_owner(uuid);
drop function if exists public.add_project_owner_member();
drop function if exists public.set_updated_at();
drop function if exists public.is_registered_user();
drop function if exists public.is_superuser();
drop function if exists public.delete_project_model_storage_object();

create extension if not exists "pgcrypto";

create or replace function public.set_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

create or replace function public.is_registered_user()
returns boolean
language sql
stable
as $$
    select auth.uid() is not null
        and coalesce(auth.jwt() ->> 'email', '') <> ''
        and coalesce(auth.jwt() ->> 'is_anonymous', 'false') <> 'true';
$$;

create or replace function public.delete_project_model_storage_object()
returns trigger
language plpgsql
security definer
set search_path = public, storage
as $$
declare
    raw_path text;
    bucket text;
    object_name text;
    meta_storage_path text;
begin
    meta_storage_path := coalesce(old.meta ->> 'storagePath', old.meta ->> 'storage_path', '');
    if meta_storage_path <> '' then
        bucket := 'models';
        object_name := ltrim(meta_storage_path, '/');
    elsif old.url is null or old.url = '' then
        return old;
    elsif position('storage://' in old.url) = 1 then
        raw_path := substr(old.url, length('storage://') + 1);
        bucket := split_part(raw_path, '/', 1);
        object_name := substr(raw_path, length(bucket) + 2);
    elsif position('/storage/v1/object/' in old.url) > 0 then
        raw_path := split_part(old.url, '/storage/v1/object/', 2);
        raw_path := split_part(raw_path, '?', 1);
        if raw_path = '' then
            return old;
        end if;
        raw_path := regexp_replace(raw_path, '^(public|sign|authenticated)/', '');
        bucket := split_part(raw_path, '/', 1);
        object_name := substr(raw_path, length(bucket) + 2);
    else
        return old;
    end if;

    if bucket = '' or object_name = '' then
        return old;
    end if;

    begin
        delete from storage.objects
        where bucket_id = bucket
          and name = object_name;
    exception
        when insufficient_privilege then
            null;
    end;

    return old;
end;
$$;

create table if not exists public.projects (
    id uuid primary key default gen_random_uuid(),
    slug text not null unique,
    name text not null,
    owner_id uuid not null references auth.users(id) on delete cascade,
    meta jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.project_members (
    project_id uuid not null references public.projects(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    role text not null default 'member',
    created_at timestamptz not null default now(),
    primary key (project_id, user_id)
);

create or replace function public.add_project_owner_member()
returns trigger as $$
begin
    insert into public.project_members (project_id, user_id, role)
    values (new.id, new.owner_id, 'owner')
    on conflict do nothing;
    return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists projects_updated_at on public.projects;
create trigger projects_updated_at
before update on public.projects
for each row execute function public.set_updated_at();

drop trigger if exists projects_owner_member on public.projects;
create trigger projects_owner_member
after insert on public.projects
for each row execute function public.add_project_owner_member();

create table if not exists public.project_models (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references public.projects(id) on delete cascade,
    name text not null,
    url text not null,
    meta jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (id, project_id)
);

drop trigger if exists project_models_updated_at on public.project_models;
create trigger project_models_updated_at
before update on public.project_models
for each row execute function public.set_updated_at();

drop trigger if exists project_models_storage_delete on public.project_models;
create trigger project_models_storage_delete
after delete on public.project_models
for each row execute function public.delete_project_model_storage_object();

create table if not exists public.rooms (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references public.projects(id) on delete cascade,
    slug text not null,
    owner_id uuid not null references auth.users(id) on delete cascade,
    active_model_id uuid,
    camera_state jsonb,
    camera_owner_id uuid references auth.users(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (project_id, slug),
    unique (id, project_id),
    foreign key (active_model_id, project_id) references public.project_models(id, project_id)
);

drop trigger if exists rooms_updated_at on public.rooms;
create trigger rooms_updated_at
before update on public.rooms
for each row execute function public.set_updated_at();

create or replace function public.set_room_project_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    select p.owner_id into new.owner_id from public.projects p where p.id = new.project_id;
    if new.owner_id is null then
        raise exception 'project not found' using errcode = '23503';
    end if;
    return new;
end;
$$;
revoke all on function public.set_room_project_owner() from public, anon, authenticated;
create trigger rooms_project_owner before insert or update of owner_id, project_id on public.rooms
    for each row execute function public.set_room_project_owner();

create table if not exists public.room_invites (
    room_id uuid primary key,
    project_id uuid not null,
    token text not null unique,
    created_by uuid not null references auth.users(id) on delete cascade,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    foreign key (room_id, project_id) references public.rooms(id, project_id) on delete cascade
);

drop trigger if exists room_invites_updated_at on public.room_invites;
create trigger room_invites_updated_at
before update on public.room_invites
for each row execute function public.set_updated_at();

create table if not exists public.room_members (
    room_id uuid not null,
    project_id uuid not null,
    user_id uuid not null references auth.users(id) on delete cascade,
    role text not null default 'guest',
    created_at timestamptz not null default now(),
    primary key (room_id, user_id),
    foreign key (room_id, project_id) references public.rooms(id, project_id) on delete cascade
);

create index if not exists room_members_project_user_idx
    on public.room_members (project_id, user_id);

create table if not exists public.room_models (
    room_id uuid not null,
    project_id uuid not null,
    model_id uuid not null,
    sort_order integer not null default 0,
    visible boolean not null default true,
    transform jsonb,
    created_at timestamptz not null default now(),
    primary key (room_id, model_id),
    foreign key (room_id, project_id) references public.rooms(id, project_id) on delete cascade,
    foreign key (model_id, project_id) references public.project_models(id, project_id) on delete cascade
);

create table if not exists public.room_cameras (
    id uuid primary key default gen_random_uuid(),
    room_id uuid not null references public.rooms(id) on delete cascade,
    name text not null,
    position jsonb not null,
    target jsonb not null,
    up jsonb,
    fov double precision,
    zoom double precision,
    near double precision,
    far double precision,
    shift_x double precision,
    shift_y double precision,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

drop trigger if exists room_cameras_updated_at on public.room_cameras;
create trigger room_cameras_updated_at
before update on public.room_cameras
for each row execute function public.set_updated_at();

create table if not exists public.room_transitions (
    id uuid primary key default gen_random_uuid(),
    room_id uuid not null references public.rooms(id) on delete cascade,
    from_camera_id uuid not null references public.room_cameras(id) on delete cascade,
    to_camera_id uuid not null references public.room_cameras(id) on delete cascade,
    seconds double precision not null default 0,
    type text not null default 'ease-in-out',
    trajectory text not null default 'linear',
    created_at timestamptz not null default now()
);

create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    display_name text not null,
    created_at timestamptz not null default now()
);

create table if not exists public.user_roles (
    user_id uuid not null references auth.users(id) on delete cascade,
    role text not null,
    created_at timestamptz not null default now(),
    primary key (user_id, role)
);

create table if not exists public.integration_secrets (
    name text primary key,
    secret_value text not null,
    updated_at timestamptz not null default now(),
    updated_by uuid references auth.users(id) on delete set null,
    constraint integration_secrets_name_format check (name ~ '^[a-z0-9_]{1,64}$'),
    constraint integration_secrets_value_size check (char_length(secret_value) between 1 and 4096)
);

create or replace function public.is_superuser()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1
        from public.user_roles
        where user_id = auth.uid()
          and role = 'superuser'
    );
$$;

create table if not exists public.annotations (
    id uuid primary key default gen_random_uuid(),
    room_id uuid not null references public.rooms(id) on delete cascade,
    author_id uuid not null references auth.users(id) on delete cascade,
    author_name text not null,
    kind text not null,
    payload jsonb not null,
    created_at timestamptz not null default now()
);

create index if not exists annotations_room_created_idx
    on public.annotations (room_id, created_at);

create table if not exists public.messages (
    id uuid primary key default gen_random_uuid(),
    room_id uuid not null references public.rooms(id) on delete cascade,
    author_id uuid not null references auth.users(id) on delete cascade,
    author_name text not null,
    body text not null,
    created_at timestamptz not null default now()
);

create index if not exists messages_room_created_idx
    on public.messages (room_id, created_at);

create index if not exists project_models_project_idx
    on public.project_models (project_id, created_at);

create index if not exists rooms_project_idx
    on public.rooms (project_id, created_at);

create index if not exists room_models_room_idx
    on public.room_models (room_id, sort_order);

create or replace function public.is_project_owner(check_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.is_superuser()
        or exists (
            select 1
            from public.projects p
            where p.id = check_project_id
              and p.owner_id = auth.uid()
        );
$$;

create or replace function public.is_room_owner(check_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from public.rooms r
        where r.id = check_room_id and public.is_project_owner(r.project_id)
    );
$$;

create or replace function public.can_access_room(check_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.is_room_owner(check_room_id)
        or exists (
            select 1
            from public.room_members rm
            where rm.room_id = check_room_id
              and rm.user_id = auth.uid()
        );
$$;

create or replace function public.can_access_project(check_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.is_project_owner(check_project_id)
        or exists (
            select 1
            from public.rooms r
            join public.room_members rm on rm.room_id = r.id
            where r.project_id = check_project_id
              and rm.user_id = auth.uid()
        );
$$;

create or replace function public.can_access_project_model(check_model_id uuid, check_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.is_project_owner(check_project_id)
        or exists (
            select 1
            from public.room_models rmo
            join public.room_members rm on rm.room_id = rmo.room_id
            where rmo.model_id = check_model_id
              and rmo.project_id = check_project_id
              and rm.user_id = auth.uid()
        );
$$;

create or replace function public.can_manage_room_models(check_room_id uuid, check_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.is_room_owner(check_room_id)
        or public.is_project_owner(check_project_id);
$$;

create or replace function public.can_upload_model_storage_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    with parts as (
        select string_to_array(trim(leading '/' from coalesce(object_name, '')), '/') as p
    )
    select coalesce((
        select array_length(p, 1) >= 2
            and p[1] = 'projects'
            and p[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            and public.is_project_owner(p[2]::uuid)
        from parts
    ), false);
$$;

create or replace function public.can_access_model_storage_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    with clean as (
        select trim(leading '/' from coalesce(object_name, '')) as path
    )
    select public.can_upload_model_storage_object(object_name)
        or exists (
            select 1
            from clean
            join public.project_models pm
              on pm.meta ->> 'storagePath' = clean.path
              or pm.meta ->> 'storage_path' = clean.path
              or pm.url = 'storage://models/' || clean.path
            where public.can_access_project_model(pm.id, pm.project_id)
        );
$$;

create or replace function public.join_project_by_slug(project_slug text, room_slug text)
returns public.projects
language plpgsql
security definer
set search_path = public
as $$
declare
    proj public.projects;
begin
    if auth.uid() is null then
        raise exception 'not authenticated' using errcode = '42501';
    end if;
    select p.* into proj from public.projects p
    join public.rooms r on r.project_id = p.id
    where p.slug = project_slug and r.slug = room_slug and public.can_access_room(r.id)
    limit 1;
    if proj.id is null then
        raise exception 'room unavailable; a valid invitation is required' using errcode = '42501';
    end if;
    return proj;
end;
$$;

create or replace function public.project_admin_owners()
returns table (user_id uuid, email text)
language sql stable security definer set search_path = public as $$
    select distinct u.id, u.email::text
    from public.projects p join auth.users u on u.id = p.owner_id
    where public.is_registered_user() and public.is_project_owner(p.id);
$$;
revoke all on function public.project_admin_owners() from public, anon;
grant execute on function public.project_admin_owners() to authenticated, service_role;

-- Only a database-backed superuser role can read this limited Auth projection.
create or replace function public.admin_list_registered_users(
    search_text text default '', page_offset integer default 0, page_size integer default 50
)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
    result jsonb;
    query text := lower(left(btrim(coalesce(search_text, '')), 200));
begin
    if not coalesce(public.is_registered_user() and public.is_superuser(), false)
        or not exists (
            select 1 from auth.users u where u.id = auth.uid()
                and not coalesce(u.is_anonymous, false) and u.deleted_at is null
                and nullif(btrim(u.email), '') is not null
        ) then
        raise exception 'superuser access required' using errcode = '42501';
    end if;

    with registered as (
        select u.id as user_id, u.email::text, p.display_name,
            case when exists (select 1 from public.user_roles r
                where r.user_id = u.id and r.role = 'superuser')
                then 'superuser' else 'user' end as role,
            u.created_at, u.last_sign_in_at, (u.email_confirmed_at is not null) as email_confirmed
        from auth.users u left join public.profiles p on p.id = u.id
        where not coalesce(u.is_anonymous, false) and u.deleted_at is null
            and nullif(btrim(u.email), '') is not null
            and (query = '' or strpos(lower(u.email), query) > 0
                or strpos(lower(coalesce(p.display_name, '')), query) > 0)
    ), page as (
        select * from registered
        order by created_at desc nulls last, user_id
        limit least(100, greatest(1, coalesce(page_size, 50)))
        offset greatest(0, coalesce(page_offset, 0))
    )
    select jsonb_build_object(
        'total', (select count(*) from registered),
        'users', coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at desc nulls last, p.user_id)
            from page p), '[]'::jsonb)
    ) into result;
    return result;
end;
$$;
revoke all on function public.admin_list_registered_users(text, integer, integer) from public, anon;
grant execute on function public.admin_list_registered_users(text, integer, integer) to authenticated;

create or replace function public.ensure_room_invite(room_id uuid)
returns table (token text)
language plpgsql
security definer
set search_path = public
as $$
declare
    room_row public.rooms;
    invite_row public.room_invites;
begin
    if auth.uid() is null then
        raise exception 'not authenticated';
    end if;

    select r.*
    into room_row
    from public.rooms r
    where r.id = room_id
      and public.is_room_owner(r.id)
    limit 1;

    if room_row.id is null then
        raise exception 'room not found';
    end if;

    select ri.*
    into invite_row
    from public.room_invites ri
    where ri.room_id = room_row.id
    limit 1;

    if invite_row.room_id is null then
        insert into public.room_invites (room_id, project_id, token, created_by)
        values (room_row.id, room_row.project_id, encode(extensions.gen_random_bytes(24), 'hex'), auth.uid())
        returning * into invite_row;
    end if;

    return query
    select invite_row.token;
end;
$$;

create or replace function public.join_room_by_invite(invite_token text)
returns public.rooms
language plpgsql
security definer
set search_path = public
as $$
declare
    room_row public.rooms;
begin
    if auth.uid() is null then
        raise exception 'not authenticated';
    end if;
    if coalesce(trim(invite_token), '') = '' then
        raise exception 'invite token required';
    end if;

    select r.*
    into room_row
    from public.room_invites ri
    join public.rooms r
      on r.id = ri.room_id
     and r.project_id = ri.project_id
    where ri.token = trim(invite_token)
    limit 1;

    if room_row.id is null then
        raise exception 'room invite not found';
    end if;

    insert into public.room_members (room_id, project_id, user_id, role)
    values (room_row.id, room_row.project_id, auth.uid(), 'guest')
    on conflict do nothing;

    return room_row;
end;
$$;

create or replace function public.claim_camera(room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if auth.uid() is null then
        raise exception 'not authenticated';
    end if;
    update public.rooms
    set camera_owner_id = auth.uid()
    where id = room_id
      and public.can_access_room(room_id);
end;
$$;

create or replace function public.release_camera(room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if auth.uid() is null then
        raise exception 'not authenticated';
    end if;
    update public.rooms
    set camera_owner_id = null
    where id = room_id
      and public.can_access_room(room_id)
      and (camera_owner_id = auth.uid() or public.is_room_owner(room_id));
end;
$$;

revoke all on function public.join_project_by_slug(text, text) from public;
revoke all on function public.ensure_room_invite(uuid) from public;
revoke all on function public.join_room_by_invite(text) from public;
revoke all on function public.claim_camera(uuid) from public;
revoke all on function public.release_camera(uuid) from public;
grant execute on function public.join_project_by_slug(text, text) to authenticated;
grant execute on function public.ensure_room_invite(uuid) to authenticated;
grant execute on function public.join_room_by_invite(text) to authenticated;
grant execute on function public.claim_camera(uuid) to authenticated;
grant execute on function public.release_camera(uuid) to authenticated;
grant execute on function public.join_project_by_slug(text, text) to service_role;
grant execute on function public.ensure_room_invite(uuid) to service_role;
grant execute on function public.join_room_by_invite(text) to service_role;
grant execute on function public.is_registered_user() to authenticated;
grant execute on function public.is_superuser() to authenticated;
grant execute on function public.is_project_owner(uuid) to authenticated;
grant execute on function public.is_room_owner(uuid) to authenticated;
grant execute on function public.can_access_room(uuid) to authenticated;
grant execute on function public.can_access_project(uuid) to authenticated;
grant execute on function public.can_access_project_model(uuid, uuid) to authenticated;
grant execute on function public.can_manage_room_models(uuid, uuid) to authenticated;
grant execute on function public.can_upload_model_storage_object(text) to authenticated;
grant execute on function public.can_access_model_storage_object(text) to authenticated;

alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.project_models enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.room_models enable row level security;
alter table public.room_cameras enable row level security;
alter table public.room_transitions enable row level security;
alter table public.room_invites enable row level security;
alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.integration_secrets enable row level security;
alter table public.integration_secrets force row level security;
alter table public.annotations enable row level security;
alter table public.messages enable row level security;

grant all on table public.room_members to authenticated;
grant all on table public.room_members to service_role;
revoke all on table public.integration_secrets from public, anon, authenticated;
grant select, insert, update, delete on table public.integration_secrets to service_role;

create policy "projects_select" on public.projects
    for select to authenticated
    using (
        owner_id = auth.uid()
        or public.can_access_project(id)
    );

create policy "projects_insert" on public.projects
    for insert to authenticated
    with check (owner_id = auth.uid() and public.is_registered_user());

create policy "projects_update" on public.projects
    for update to authenticated
    using (public.is_project_owner(id))
    with check (owner_id = auth.uid() or public.is_superuser());

create policy "projects_delete" on public.projects
    for delete to authenticated
    using (public.is_project_owner(id));

create policy "project_members_select" on public.project_members
    for select to authenticated
    using (user_id = auth.uid() or public.is_project_owner(project_id));

create policy "project_members_insert" on public.project_members
    for insert to authenticated
    with check (public.is_project_owner(project_id));

create policy "project_members_delete" on public.project_members
    for delete to authenticated
    using (user_id = auth.uid() or public.is_project_owner(project_id));

create policy "room_members_select" on public.room_members
    for select to authenticated
    using (user_id = auth.uid() or public.is_room_owner(room_id));

create policy "room_members_insert" on public.room_members
    for insert to authenticated
    with check (public.is_room_owner(room_id));

create policy "room_members_delete" on public.room_members
    for delete to authenticated
    using (user_id = auth.uid() or public.is_room_owner(room_id));

create policy "project_models_select" on public.project_models
    for select to authenticated
    using (public.can_access_project_model(id, project_id));

create policy "project_models_insert" on public.project_models
    for insert to authenticated
    with check (public.is_project_owner(project_id));

create policy "project_models_update" on public.project_models
    for update to authenticated
    using (public.is_project_owner(project_id))
    with check (public.is_project_owner(project_id));

create policy "project_models_delete" on public.project_models
    for delete to authenticated
    using (public.is_project_owner(project_id));

create policy "rooms_select" on public.rooms
    for select to authenticated
    using (
        owner_id = auth.uid()
        or public.can_access_room(id)
    );

create policy "rooms_insert" on public.rooms
    for insert to authenticated
    with check (
        public.is_registered_user()
        and public.is_project_owner(project_id)
    );

create policy "rooms_update" on public.rooms
    for update to authenticated
    using (public.is_room_owner(id))
    with check (public.is_room_owner(id));

create policy "rooms_delete" on public.rooms
    for delete to authenticated
    using (public.is_room_owner(id));

create policy "room_models_select" on public.room_models
    for select to authenticated
    using (public.can_access_room(room_id));

create policy "room_models_insert" on public.room_models
    for insert to authenticated
    with check (public.can_manage_room_models(room_id, project_id));

create policy "room_models_update" on public.room_models
    for update to authenticated
    using (public.can_manage_room_models(room_id, project_id))
    with check (public.can_manage_room_models(room_id, project_id));

create policy "room_models_delete" on public.room_models
    for delete to authenticated
    using (public.can_manage_room_models(room_id, project_id));

create policy "room_cameras_select" on public.room_cameras
    for select to authenticated
    using (public.can_access_room(room_id));

create policy "room_cameras_insert" on public.room_cameras
    for insert to authenticated
    with check (public.can_access_room(room_id));

create policy "room_cameras_update" on public.room_cameras
    for update to authenticated
    using (public.can_access_room(room_id))
    with check (public.can_access_room(room_id));

create policy "room_cameras_delete" on public.room_cameras
    for delete to authenticated
    using (public.is_room_owner(room_id));

create policy "room_transitions_select" on public.room_transitions
    for select to authenticated
    using (public.can_access_room(room_id));

create policy "room_transitions_insert" on public.room_transitions
    for insert to authenticated
    with check (public.can_access_room(room_id));

create policy "room_transitions_update" on public.room_transitions
    for update to authenticated
    using (public.can_access_room(room_id))
    with check (public.can_access_room(room_id));

create policy "room_transitions_delete" on public.room_transitions
    for delete to authenticated
    using (public.is_room_owner(room_id));

create policy "room_invites_select" on public.room_invites
    for select to authenticated
    using (public.is_room_owner(room_id));

create policy "room_invites_insert" on public.room_invites
    for insert to authenticated
    with check (public.is_room_owner(room_id));

create policy "room_invites_update" on public.room_invites
    for update to authenticated
    using (public.is_room_owner(room_id))
    with check (public.is_room_owner(room_id));

create policy "room_invites_delete" on public.room_invites
    for delete to authenticated
    using (public.is_room_owner(room_id));

create policy "profiles_select" on public.profiles
    for select to authenticated
    using (true);

create policy "profiles_insert" on public.profiles
    for insert to authenticated
    with check (id = auth.uid());

create policy "profiles_update" on public.profiles
    for update to authenticated
    using (id = auth.uid())
    with check (id = auth.uid());

create policy "annotations_select" on public.annotations
    for select to authenticated
    using (public.can_access_room(room_id));

create policy "annotations_insert" on public.annotations
    for insert to authenticated
    with check (author_id = auth.uid() and public.can_access_room(room_id));

create policy "annotations_delete" on public.annotations
    for delete to authenticated
    using (author_id = auth.uid() or public.is_room_owner(room_id));

create policy "messages_select" on public.messages
    for select to authenticated
    using (public.can_access_room(room_id));

create policy "messages_insert" on public.messages
    for insert to authenticated
    with check (author_id = auth.uid() and public.can_access_room(room_id));

create policy "messages_delete" on public.messages
    for delete to authenticated
    using (author_id = auth.uid() or public.is_superuser());

revoke update on public.projects, public.rooms from anon, authenticated;
grant update (name, slug, meta) on public.projects to authenticated;
grant update (slug, active_model_id, camera_state, camera_owner_id) on public.rooms to authenticated;

-- Superuser bootstrap (run after the user registers).
insert into public.user_roles (user_id, role)
select id, 'superuser'
from auth.users
where lower(email) = 'maragojeep@gmail.com'
on conflict do nothing;

-- Realtime (optional): enable row changes in Supabase Realtime.
-- alter publication supabase_realtime add table public.projects;
-- alter publication supabase_realtime add table public.rooms;
-- alter publication supabase_realtime add table public.room_members;
-- alter publication supabase_realtime add table public.room_models;
-- alter publication supabase_realtime add table public.room_cameras;
-- alter publication supabase_realtime add table public.room_transitions;
-- alter publication supabase_realtime add table public.annotations;
-- alter publication supabase_realtime add table public.messages;

-- Storage: private bucket for model files.
insert into storage.buckets (id, name, public)
values ('models', 'models', false)
on conflict (id) do update
set public = excluded.public;

drop policy if exists "models_upload" on storage.objects;
create policy "models_upload" on storage.objects
for insert to authenticated
with check (
    bucket_id = 'models'
    and public.can_upload_model_storage_object(name)
);

drop policy if exists "models_read" on storage.objects;
create policy "models_read" on storage.objects
for select to authenticated
using (
    bucket_id = 'models'
    and public.can_access_model_storage_object(name)
);

drop policy if exists "models_delete" on storage.objects;
create policy "models_delete" on storage.objects
for delete to authenticated
using (
    bucket_id = 'models'
    and public.can_upload_model_storage_object(name)
);
