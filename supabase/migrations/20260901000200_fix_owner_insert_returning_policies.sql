begin;

drop policy if exists "projects_select" on public.projects;
create policy "projects_select" on public.projects
    for select to authenticated
    using (
        owner_id = auth.uid()
        or public.can_access_project(id)
    );

drop policy if exists "rooms_select" on public.rooms;
create policy "rooms_select" on public.rooms
    for select to authenticated
    using (
        owner_id = auth.uid()
        or public.can_access_room(id)
    );

commit;

notify pgrst, 'reload schema';
