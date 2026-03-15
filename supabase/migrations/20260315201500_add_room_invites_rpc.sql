create table if not exists public.room_invites (
    room_id uuid primary key,
    project_id uuid not null,
    token text not null unique,
    created_by uuid not null references auth.users(id) on delete cascade,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    foreign key (room_id, project_id) references public.rooms(id, project_id) on delete cascade
);

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'room_invites_pkey'
          and conrelid = 'public.room_invites'::regclass
    ) then
        alter table public.room_invites
            add constraint room_invites_pkey primary key (room_id);
    end if;
end;
$$;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'room_invites_token_key'
          and conrelid = 'public.room_invites'::regclass
    ) then
        alter table public.room_invites
            add constraint room_invites_token_key unique (token);
    end if;
end;
$$;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'room_invites_created_by_fkey'
          and conrelid = 'public.room_invites'::regclass
    ) then
        alter table public.room_invites
            add constraint room_invites_created_by_fkey
            foreign key (created_by) references auth.users(id) on delete cascade;
    end if;
end;
$$;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'room_invites_room_id_project_id_fkey'
          and conrelid = 'public.room_invites'::regclass
    ) then
        alter table public.room_invites
            add constraint room_invites_room_id_project_id_fkey
            foreign key (room_id, project_id) references public.rooms(id, project_id) on delete cascade;
    end if;
end;
$$;

create index if not exists room_invites_project_idx
    on public.room_invites (project_id, created_at);

drop trigger if exists room_invites_updated_at on public.room_invites;
create trigger room_invites_updated_at
before update on public.room_invites
for each row execute function public.set_updated_at();

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
      and exists (
          select 1
          from public.project_members pm
          where pm.project_id = r.project_id
            and pm.user_id = auth.uid()
      )
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
        values (room_row.id, room_row.project_id, encode(gen_random_bytes(24), 'hex'), auth.uid())
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

    insert into public.project_members (project_id, user_id, role)
    values (room_row.project_id, auth.uid(), 'member')
    on conflict do nothing;

    return room_row;
end;
$$;

revoke all on function public.ensure_room_invite(uuid) from public;
revoke all on function public.join_room_by_invite(text) from public;
grant execute on function public.ensure_room_invite(uuid) to authenticated;
grant execute on function public.ensure_room_invite(uuid) to service_role;
grant execute on function public.join_room_by_invite(text) to authenticated;
grant execute on function public.join_room_by_invite(text) to service_role;

alter table public.room_invites enable row level security;

grant all on table public.room_invites to anon;
grant all on table public.room_invites to authenticated;
grant all on table public.room_invites to service_role;
