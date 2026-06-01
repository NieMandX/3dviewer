insert into public.room_members (room_id, project_id, user_id, role)
select room_id, project_id, user_id, 'owner'
from (
    select r.id as room_id, r.project_id, p.owner_id as user_id
    from public.rooms r
    join public.projects p on p.id = r.project_id
    where p.owner_id is not null

    union

    select r.id as room_id, r.project_id, r.owner_id as user_id
    from public.rooms r
    where r.owner_id is not null
) owners
on conflict (room_id, user_id) do update
set role = 'owner';

with single_room_projects as (
    select project_id, (array_agg(id order by created_at asc, id::text asc))[1] as room_id
    from public.rooms
    group by project_id
    having count(*) = 1
)
insert into public.room_members (room_id, project_id, user_id, role)
select
    sr.room_id,
    pm.project_id,
    pm.user_id,
    case when pm.role = 'owner' then 'owner' else 'guest' end
from public.project_members pm
join single_room_projects sr on sr.project_id = pm.project_id
where pm.user_id is not null
on conflict (room_id, user_id) do update
set role = case
    when excluded.role = 'owner' then 'owner'
    else public.room_members.role
end;
