begin;
create table if not exists public.room_material_settings (
    room_id uuid primary key references public.rooms(id) on delete cascade,
    filename text not null default 'materials.lpmview.json',
    document jsonb not null,
    revision bigint not null default 1,
    updated_by uuid references auth.users(id) on delete set null,
    updated_at timestamptz not null default now(),
    check (coalesce(jsonb_typeof(document) = 'object' and document->>'format' = 'lpmview-materials' and document->>'version' = '1' and jsonb_typeof(document->'materials') = 'array', false)),
    check (octet_length(document::text) <= 16777216)
);
alter table public.room_material_settings enable row level security;
grant select on public.room_material_settings to authenticated;
create policy material_settings_read on public.room_material_settings for select to authenticated using (public.can_access_room(room_id));

create or replace function public.save_room_material_settings(p_room_id uuid, p_document jsonb, p_expected_revision bigint)
returns bigint language plpgsql security definer set search_path = public as $$
declare next_revision bigint; project uuid;
begin
    if p_expected_revision is null or p_expected_revision < 0 then raise exception 'Invalid revision' using errcode = '22023'; end if;
    select project_id into project from public.rooms where id = p_room_id;
    if project is null or not public.can_manage_room_models(p_room_id, project) then
        raise exception 'Only the project owner can save room materials' using errcode = '42501';
    end if;
    -- Serialize simultaneous first writes as well as later revisions.
    perform pg_advisory_xact_lock(hashtextextended(p_room_id::text, 0));
    if coalesce((select revision from public.room_material_settings where room_id = p_room_id), 0) <> p_expected_revision then
        raise exception 'Material settings changed in another session' using errcode = '40001';
    end if;
    insert into public.room_material_settings(room_id, document, revision, updated_by)
    values (p_room_id, p_document, 1, auth.uid())
    on conflict (room_id) do update set document = excluded.document, revision = room_material_settings.revision + 1, updated_by = auth.uid(), updated_at = now()
    returning revision into next_revision;
    return next_revision;
end;
$$;
revoke all on function public.save_room_material_settings(uuid,jsonb,bigint) from public;
grant execute on function public.save_room_material_settings(uuid,jsonb,bigint) to authenticated;
notify pgrst, 'reload schema';
commit;
