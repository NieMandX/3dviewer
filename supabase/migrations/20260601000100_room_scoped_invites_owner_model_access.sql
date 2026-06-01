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

drop function if exists public.join_project_by_slug(text);

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
    select public.is_superuser()
        or exists (
            select 1
            from public.rooms r
            join public.projects p on p.id = r.project_id
            where r.id = check_room_id
              and (r.owner_id = auth.uid() or p.owner_id = auth.uid())
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
    room_row public.rooms;
begin
    if auth.uid() is null then
        raise exception 'not authenticated';
    end if;
    if coalesce(trim(room_slug), '') = '' then
        raise exception 'room slug required';
    end if;

    select r.*
    into room_row
    from public.projects p
    join public.rooms r on r.project_id = p.id
    where p.slug = project_slug
      and r.slug = room_slug
    limit 1;

    if room_row.id is null then
        raise exception 'project room link not found';
    end if;

    select *
    into proj
    from public.projects
    where id = room_row.project_id
    limit 1;

    insert into public.room_members (room_id, project_id, user_id, role)
    values (room_row.id, room_row.project_id, auth.uid(), 'guest')
    on conflict do nothing;

    return proj;
end;
$$;

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
grant execute on function public.is_project_owner(uuid) to authenticated;
grant execute on function public.is_room_owner(uuid) to authenticated;
grant execute on function public.can_access_room(uuid) to authenticated;
grant execute on function public.can_access_project(uuid) to authenticated;
grant execute on function public.can_access_project_model(uuid, uuid) to authenticated;
grant execute on function public.can_manage_room_models(uuid, uuid) to authenticated;
grant execute on function public.can_upload_model_storage_object(text) to authenticated;
grant execute on function public.can_access_model_storage_object(text) to authenticated;

alter table public.room_members enable row level security;
grant all on table public.room_members to authenticated;
grant all on table public.room_members to service_role;

drop policy if exists "projects_select" on public.projects;
drop policy if exists "projects_insert" on public.projects;
drop policy if exists "projects_update" on public.projects;
drop policy if exists "projects_delete" on public.projects;
drop policy if exists "project_members_select" on public.project_members;
drop policy if exists "project_members_insert" on public.project_members;
drop policy if exists "project_members_delete" on public.project_members;
drop policy if exists "room_members_select" on public.room_members;
drop policy if exists "room_members_insert" on public.room_members;
drop policy if exists "room_members_delete" on public.room_members;
drop policy if exists "project_models_select" on public.project_models;
drop policy if exists "project_models_insert" on public.project_models;
drop policy if exists "project_models_update" on public.project_models;
drop policy if exists "project_models_delete" on public.project_models;
drop policy if exists "rooms_select" on public.rooms;
drop policy if exists "rooms_insert" on public.rooms;
drop policy if exists "rooms_update" on public.rooms;
drop policy if exists "rooms_delete" on public.rooms;
drop policy if exists "room_models_select" on public.room_models;
drop policy if exists "room_models_insert" on public.room_models;
drop policy if exists "room_models_update" on public.room_models;
drop policy if exists "room_models_delete" on public.room_models;
drop policy if exists "room_cameras_select" on public.room_cameras;
drop policy if exists "room_cameras_insert" on public.room_cameras;
drop policy if exists "room_cameras_update" on public.room_cameras;
drop policy if exists "room_cameras_delete" on public.room_cameras;
drop policy if exists "room_transitions_select" on public.room_transitions;
drop policy if exists "room_transitions_insert" on public.room_transitions;
drop policy if exists "room_transitions_update" on public.room_transitions;
drop policy if exists "room_transitions_delete" on public.room_transitions;
drop policy if exists "room_invites_select" on public.room_invites;
drop policy if exists "room_invites_insert" on public.room_invites;
drop policy if exists "room_invites_update" on public.room_invites;
drop policy if exists "room_invites_delete" on public.room_invites;
drop policy if exists "annotations_select" on public.annotations;
drop policy if exists "annotations_insert" on public.annotations;
drop policy if exists "annotations_delete" on public.annotations;
drop policy if exists "messages_select" on public.messages;
drop policy if exists "messages_insert" on public.messages;
drop policy if exists "messages_delete" on public.messages;

create policy "projects_select" on public.projects
    for select to authenticated
    using (public.can_access_project(id));

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
    using (public.can_access_room(id));

create policy "rooms_insert" on public.rooms
    for insert to authenticated
    with check (
        owner_id = auth.uid()
        and public.is_registered_user()
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

notify pgrst, 'reload schema';
