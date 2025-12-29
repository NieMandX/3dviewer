-- Supabase schema for collaborative rooms, annotations, and chat.
-- Run in Supabase SQL editor.

create extension if not exists "pgcrypto";

create or replace function public.set_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

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
    where id = room_id;
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
      and (camera_owner_id = auth.uid() or owner_id = auth.uid());
end;
$$;

revoke all on function public.claim_camera(uuid) from public;
revoke all on function public.release_camera(uuid) from public;
grant execute on function public.claim_camera(uuid) to authenticated;
grant execute on function public.release_camera(uuid) to authenticated;

create table if not exists public.rooms (
    id uuid primary key default gen_random_uuid(),
    slug text not null unique,
    owner_id uuid not null references auth.users(id) on delete cascade,
    model_url text,
    model_name text,
    model_meta jsonb,
    camera_state jsonb,
    camera_owner_id uuid references auth.users(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

drop trigger if exists rooms_updated_at on public.rooms;
create trigger rooms_updated_at
before update on public.rooms
for each row execute function public.set_updated_at();

create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    display_name text not null,
    created_at timestamptz not null default now()
);

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

alter table public.rooms enable row level security;
alter table public.profiles enable row level security;
alter table public.annotations enable row level security;
alter table public.messages enable row level security;

create policy "rooms_select" on public.rooms
    for select to authenticated
    using (true);

create policy "rooms_insert" on public.rooms
    for insert to authenticated
    with check (owner_id = auth.uid());

create policy "rooms_update" on public.rooms
    for update to authenticated
    using (
        owner_id = auth.uid()
        or camera_owner_id is null
        or camera_owner_id = auth.uid()
    )
    with check (
        camera_owner_id is null
        or camera_owner_id = auth.uid()
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
    using (true);

create policy "annotations_insert" on public.annotations
    for insert to authenticated
    with check (author_id = auth.uid());

create policy "annotations_delete" on public.annotations
    for delete to authenticated
    using (author_id = auth.uid());

create policy "messages_select" on public.messages
    for select to authenticated
    using (true);

create policy "messages_insert" on public.messages
    for insert to authenticated
    with check (author_id = auth.uid());

create policy "messages_delete" on public.messages
    for delete to authenticated
    using (author_id = auth.uid());

-- Realtime (optional): enable row changes in Supabase Realtime.
-- alter publication supabase_realtime add table public.rooms;
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
