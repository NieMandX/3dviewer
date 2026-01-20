-- Supabase schema for projects, rooms, models, cameras, annotations, and chat.
-- WARNING: This file resets related objects (drops tables/functions) before creating them.
-- Run in Supabase SQL editor.

-- Reset existing schema objects (destructive).
drop table if exists public.room_transitions cascade;
drop table if exists public.room_cameras cascade;
drop table if exists public.room_models cascade;
drop table if exists public.messages cascade;
drop table if exists public.annotations cascade;
drop table if exists public.rooms cascade;
drop table if exists public.project_models cascade;
drop table if exists public.project_members cascade;
drop table if exists public.projects cascade;
drop table if exists public.profiles cascade;
drop table if exists public.user_roles cascade;

drop function if exists public.release_camera(uuid);
drop function if exists public.claim_camera(uuid);
drop function if exists public.join_project_by_slug(text);
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
    select coalesce(auth.jwt() ->> 'email', '') <> '';
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
begin
    if old.url is null or old.url = '' then
        return old;
    end if;
    if position('/storage/v1/object/' in old.url) = 0 then
        return old;
    end if;

    raw_path := split_part(old.url, '/storage/v1/object/', 2);
    raw_path := split_part(raw_path, '?', 1);
    if raw_path = '' then
        return old;
    end if;

    raw_path := regexp_replace(raw_path, '^(public|sign)/', '');
    bucket := split_part(raw_path, '/', 1);
    object_name := substr(raw_path, length(bucket) + 2);
    if bucket = '' or object_name = '' then
        return old;
    end if;

    delete from storage.objects
    where bucket_id = bucket
      and name = object_name;

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

create or replace function public.join_project_by_slug(project_slug text)
returns public.projects
language plpgsql
security definer
set search_path = public
as $$
declare
    proj public.projects;
begin
    if auth.uid() is null then
        raise exception 'not authenticated';
    end if;
    select * into proj from public.projects where slug = project_slug limit 1;
    if proj.id is null then
        raise exception 'project not found';
    end if;
    insert into public.project_members (project_id, user_id, role)
    values (proj.id, auth.uid(), 'member')
    on conflict do nothing;
    return proj;
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
      and exists (
          select 1
          from public.project_members pm
          where pm.project_id = rooms.project_id
            and pm.user_id = auth.uid()
      );
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
      and exists (
          select 1
          from public.project_members pm
          where pm.project_id = rooms.project_id
            and pm.user_id = auth.uid()
      )
      and (camera_owner_id = auth.uid() or owner_id = auth.uid());
end;
$$;

revoke all on function public.join_project_by_slug(text) from public;
revoke all on function public.claim_camera(uuid) from public;
revoke all on function public.release_camera(uuid) from public;
grant execute on function public.join_project_by_slug(text) to authenticated;
grant execute on function public.claim_camera(uuid) to authenticated;
grant execute on function public.release_camera(uuid) to authenticated;
grant execute on function public.is_registered_user() to authenticated;
grant execute on function public.is_superuser() to authenticated;

alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.project_models enable row level security;
alter table public.rooms enable row level security;
alter table public.room_models enable row level security;
alter table public.room_cameras enable row level security;
alter table public.room_transitions enable row level security;
alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.annotations enable row level security;
alter table public.messages enable row level security;

create policy "projects_select" on public.projects
    for select to authenticated
    using (
        owner_id = auth.uid()
        or public.is_superuser()
        or exists (
            select 1
            from public.project_members pm
            where pm.project_id = projects.id
              and pm.user_id = auth.uid()
        )
    );

create policy "projects_insert" on public.projects
    for insert to authenticated
    with check (owner_id = auth.uid() and public.is_registered_user());

create policy "projects_update" on public.projects
    for update to authenticated
    using (owner_id = auth.uid())
    with check (owner_id = auth.uid());

create policy "projects_delete" on public.projects
    for delete to authenticated
    using (owner_id = auth.uid() or public.is_superuser());

create policy "project_members_select" on public.project_members
    for select to authenticated
    using (
        user_id = auth.uid()
        or public.is_superuser()
    );

create policy "project_members_insert" on public.project_members
    for insert to authenticated
    with check (
        exists (
            select 1
            from public.projects p
            where p.id = project_members.project_id
              and p.owner_id = auth.uid()
        )
    );

create policy "project_members_delete" on public.project_members
    for delete to authenticated
    using (
        user_id = auth.uid()
        or public.is_superuser()
        or exists (
            select 1
            from public.projects p
            where p.id = project_members.project_id
              and p.owner_id = auth.uid()
        )
    );

create policy "project_models_select" on public.project_models
    for select to authenticated
    using (
        public.is_superuser()
        or exists (
            select 1
            from public.project_members pm
            where pm.project_id = project_models.project_id
              and pm.user_id = auth.uid()
        )
    );

create policy "project_models_insert" on public.project_models
    for insert to authenticated
    with check (
        exists (
            select 1
            from public.project_members pm
            where pm.project_id = project_models.project_id
              and pm.user_id = auth.uid()
        )
    );

create policy "project_models_update" on public.project_models
    for update to authenticated
    using (
        exists (
            select 1
            from public.project_members pm
            where pm.project_id = project_models.project_id
              and pm.user_id = auth.uid()
        )
    )
    with check (
        exists (
            select 1
            from public.project_members pm
            where pm.project_id = project_models.project_id
              and pm.user_id = auth.uid()
        )
    );

create policy "project_models_delete" on public.project_models
    for delete to authenticated
    using (
        public.is_superuser()
        or exists (
            select 1
            from public.project_members pm
            where pm.project_id = project_models.project_id
              and pm.user_id = auth.uid()
        )
    );

create policy "rooms_select" on public.rooms
    for select to authenticated
    using (
        public.is_superuser()
        or exists (
            select 1
            from public.project_members pm
            where pm.project_id = rooms.project_id
              and pm.user_id = auth.uid()
        )
    );

create policy "rooms_insert" on public.rooms
    for insert to authenticated
    with check (
        owner_id = auth.uid()
        and public.is_registered_user()
        and exists (
            select 1
            from public.project_members pm
            where pm.project_id = rooms.project_id
              and pm.user_id = auth.uid()
        )
    );

create policy "rooms_update" on public.rooms
    for update to authenticated
    using (
        exists (
            select 1
            from public.project_members pm
            where pm.project_id = rooms.project_id
              and pm.user_id = auth.uid()
        )
        and (
            owner_id = auth.uid()
            or camera_owner_id is null
            or camera_owner_id = auth.uid()
        )
    )
    with check (
        exists (
            select 1
            from public.project_members pm
            where pm.project_id = rooms.project_id
              and pm.user_id = auth.uid()
        )
        and (
            camera_owner_id is null
            or camera_owner_id = auth.uid()
        )
    );

create policy "rooms_delete" on public.rooms
    for delete to authenticated
    using (
        owner_id = auth.uid()
        or public.is_superuser()
        or exists (
            select 1
            from public.projects p
            where p.id = rooms.project_id
              and p.owner_id = auth.uid()
        )
    );

create policy "room_models_select" on public.room_models
    for select to authenticated
    using (
        public.is_superuser()
        or exists (
            select 1
            from public.project_members pm
            where pm.project_id = room_models.project_id
              and pm.user_id = auth.uid()
        )
    );

create policy "room_models_insert" on public.room_models
    for insert to authenticated
    with check (
        exists (
            select 1
            from public.project_members pm
            where pm.project_id = room_models.project_id
              and pm.user_id = auth.uid()
        )
    );

create policy "room_models_update" on public.room_models
    for update to authenticated
    using (
        exists (
            select 1
            from public.project_members pm
            where pm.project_id = room_models.project_id
              and pm.user_id = auth.uid()
        )
    )
    with check (
        exists (
            select 1
            from public.project_members pm
            where pm.project_id = room_models.project_id
              and pm.user_id = auth.uid()
        )
    );

create policy "room_models_delete" on public.room_models
    for delete to authenticated
    using (
        public.is_superuser()
        or exists (
            select 1
            from public.project_members pm
            where pm.project_id = room_models.project_id
              and pm.user_id = auth.uid()
        )
    );

create policy "room_cameras_select" on public.room_cameras
    for select to authenticated
    using (
        public.is_superuser()
        or exists (
            select 1
            from public.rooms r
            join public.project_members pm on pm.project_id = r.project_id
            where r.id = room_cameras.room_id
              and pm.user_id = auth.uid()
        )
    );

create policy "room_cameras_insert" on public.room_cameras
    for insert to authenticated
    with check (
        exists (
            select 1
            from public.rooms r
            join public.project_members pm on pm.project_id = r.project_id
            where r.id = room_cameras.room_id
              and pm.user_id = auth.uid()
        )
    );

create policy "room_cameras_update" on public.room_cameras
    for update to authenticated
    using (
        exists (
            select 1
            from public.rooms r
            join public.project_members pm on pm.project_id = r.project_id
            where r.id = room_cameras.room_id
              and pm.user_id = auth.uid()
        )
    )
    with check (
        exists (
            select 1
            from public.rooms r
            join public.project_members pm on pm.project_id = r.project_id
            where r.id = room_cameras.room_id
              and pm.user_id = auth.uid()
        )
    );

create policy "room_cameras_delete" on public.room_cameras
    for delete to authenticated
    using (
        public.is_superuser()
        or exists (
            select 1
            from public.rooms r
            join public.project_members pm on pm.project_id = r.project_id
            where r.id = room_cameras.room_id
              and pm.user_id = auth.uid()
        )
    );

create policy "room_transitions_select" on public.room_transitions
    for select to authenticated
    using (
        public.is_superuser()
        or exists (
            select 1
            from public.rooms r
            join public.project_members pm on pm.project_id = r.project_id
            where r.id = room_transitions.room_id
              and pm.user_id = auth.uid()
        )
    );

create policy "room_transitions_insert" on public.room_transitions
    for insert to authenticated
    with check (
        exists (
            select 1
            from public.rooms r
            join public.project_members pm on pm.project_id = r.project_id
            where r.id = room_transitions.room_id
              and pm.user_id = auth.uid()
        )
    );

create policy "room_transitions_update" on public.room_transitions
    for update to authenticated
    using (
        exists (
            select 1
            from public.rooms r
            join public.project_members pm on pm.project_id = r.project_id
            where r.id = room_transitions.room_id
              and pm.user_id = auth.uid()
        )
    )
    with check (
        exists (
            select 1
            from public.rooms r
            join public.project_members pm on pm.project_id = r.project_id
            where r.id = room_transitions.room_id
              and pm.user_id = auth.uid()
        )
    );

create policy "room_transitions_delete" on public.room_transitions
    for delete to authenticated
    using (
        public.is_superuser()
        or exists (
            select 1
            from public.rooms r
            join public.project_members pm on pm.project_id = r.project_id
            where r.id = room_transitions.room_id
              and pm.user_id = auth.uid()
        )
    );

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
    using (
        public.is_superuser()
        or exists (
            select 1
            from public.rooms r
            join public.project_members pm on pm.project_id = r.project_id
            where r.id = annotations.room_id
              and pm.user_id = auth.uid()
        )
    );

create policy "annotations_insert" on public.annotations
    for insert to authenticated
    with check (
        author_id = auth.uid()
        and exists (
            select 1
            from public.rooms r
            join public.project_members pm on pm.project_id = r.project_id
            where r.id = annotations.room_id
              and pm.user_id = auth.uid()
        )
    );

create policy "annotations_delete" on public.annotations
    for delete to authenticated
    using (author_id = auth.uid() or public.is_superuser());

create policy "messages_select" on public.messages
    for select to authenticated
    using (
        public.is_superuser()
        or exists (
            select 1
            from public.rooms r
            join public.project_members pm on pm.project_id = r.project_id
            where r.id = messages.room_id
              and pm.user_id = auth.uid()
        )
    );

create policy "messages_insert" on public.messages
    for insert to authenticated
    with check (
        author_id = auth.uid()
        and exists (
            select 1
            from public.rooms r
            join public.project_members pm on pm.project_id = r.project_id
            where r.id = messages.room_id
              and pm.user_id = auth.uid()
        )
    );

create policy "messages_delete" on public.messages
    for delete to authenticated
    using (author_id = auth.uid() or public.is_superuser());

-- Superuser bootstrap (run after the user registers).
insert into public.user_roles (user_id, role)
select id, 'superuser'
from auth.users
where email = 'maragojeep@gmail.com'
on conflict do nothing;

-- Realtime (optional): enable row changes in Supabase Realtime.
-- alter publication supabase_realtime add table public.projects;
-- alter publication supabase_realtime add table public.rooms;
-- alter publication supabase_realtime add table public.room_models;
-- alter publication supabase_realtime add table public.room_cameras;
-- alter publication supabase_realtime add table public.room_transitions;
-- alter publication supabase_realtime add table public.annotations;
-- alter publication supabase_realtime add table public.messages;

-- Storage (optional): public bucket for model files.
-- insert into storage.buckets (id, name, public)
-- values ('models', 'models', true)
-- on conflict (id) do nothing;
-- create policy "models_upload" on storage.objects
-- for insert to authenticated
-- with check (bucket_id = 'models');
-- create policy "models_read" on storage.objects
-- for select to authenticated
-- using (bucket_id = 'models');
