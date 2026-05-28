drop policy if exists "annotations_delete" on public.annotations;

create policy "annotations_delete" on public.annotations
    for delete to authenticated
    using (
        author_id = auth.uid()
        or public.is_superuser()
        or exists (
            select 1
            from public.rooms r
            join public.projects p on p.id = r.project_id
            where r.id = annotations.room_id
              and (r.owner_id = auth.uid() or p.owner_id = auth.uid())
        )
    );
