-- Apply as a transaction. Project ownership is the authority for every room.
create or replace function public.is_registered_user()
returns boolean language sql stable as $$
    select auth.uid() is not null
        and coalesce(auth.jwt() ->> 'email', '') <> ''
        and coalesce(auth.jwt() ->> 'is_anonymous', 'false') <> 'true';
$$;

create or replace function public.is_room_owner(check_room_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select exists (
        select 1 from public.rooms r
        where r.id = check_room_id and public.is_project_owner(r.project_id)
    );
$$;

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
drop trigger if exists rooms_project_owner on public.rooms;
create trigger rooms_project_owner before insert or update of owner_id, project_id on public.rooms
    for each row execute function public.set_room_project_owner();

update public.rooms r set owner_id = p.owner_id
from public.projects p where r.project_id = p.id and r.owner_id is distinct from p.owner_id;

drop policy if exists rooms_insert on public.rooms;
create policy rooms_insert on public.rooms for insert to authenticated
with check (public.is_registered_user() and public.is_project_owner(project_id));

-- Room/project identities and ownership cannot be changed through the browser API.
revoke update on public.projects, public.rooms from anon, authenticated;
grant update (name, slug, meta) on public.projects to authenticated;
grant update (slug, active_model_id, camera_state, camera_owner_id) on public.rooms to authenticated;

-- A readable room name is navigation, not an invitation credential.
drop function if exists public.join_project_by_slug(text);
create or replace function public.join_project_by_slug(project_slug text, room_slug text)
returns public.projects language plpgsql security definer set search_path = public as $$
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
revoke all on function public.join_project_by_slug(text, text) from public, anon;
grant execute on function public.join_project_by_slug(text, text) to authenticated, service_role;

-- Only owners of manageable projects are disclosed, not the entire Auth directory.
create or replace function public.project_admin_owners()
returns table (user_id uuid, email text)
language sql stable security definer set search_path = public as $$
    select distinct u.id, u.email::text
    from public.projects p join auth.users u on u.id = p.owner_id
    where public.is_registered_user() and public.is_project_owner(p.id);
$$;
revoke all on function public.project_admin_owners() from public, anon;
grant execute on function public.project_admin_owners() to authenticated, service_role;

notify pgrst, 'reload schema';
