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
        values (room_row.id, room_row.project_id, encode(extensions.gen_random_bytes(24), 'hex'), auth.uid())
        returning * into invite_row;
    end if;

    return query
    select invite_row.token;
end;
$$;

revoke all on function public.ensure_room_invite(uuid) from public;
grant execute on function public.ensure_room_invite(uuid) to authenticated;
grant execute on function public.ensure_room_invite(uuid) to service_role;
