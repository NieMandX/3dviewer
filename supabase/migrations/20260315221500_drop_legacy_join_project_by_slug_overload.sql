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
        raise exception 'not authenticated';
    end if;
    if coalesce(trim(room_slug), '') = '' then
        raise exception 'room slug required';
    end if;

    select p.*
    into proj
    from public.projects p
    where p.slug = project_slug
      and exists (
          select 1
          from public.rooms r
          where r.project_id = p.id
            and r.slug = room_slug
      )
    limit 1;

    if proj.id is null then
        raise exception 'project room link not found';
    end if;

    insert into public.project_members (project_id, user_id, role)
    values (proj.id, auth.uid(), 'member')
    on conflict do nothing;

    return proj;
end;
$$;

revoke all on function public.join_project_by_slug(text, text) from public;
grant execute on function public.join_project_by_slug(text, text) to authenticated;
grant execute on function public.join_project_by_slug(text, text) to service_role;

notify pgrst, 'reload schema';
