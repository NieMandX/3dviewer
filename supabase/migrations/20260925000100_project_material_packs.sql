begin;

-- An immutable folder per saved pack. Large images live in private Storage,
-- not in the room's 16 MB JSON settings document.
create table if not exists public.project_material_packs (
    id uuid primary key,
    project_id uuid not null references public.projects(id) on delete cascade,
    name text not null check (length(btrim(name)) between 1 and 120),
    source_model text not null default '' check (length(source_model) <= 512),
    material_count integer not null check (material_count between 1 and 4096),
    texture_count integer not null check (texture_count between 0 and 90112),
    created_by uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now()
);
create index if not exists project_material_packs_project_created_idx on public.project_material_packs(project_id, created_at desc);
alter table public.project_material_packs enable row level security;
revoke all on public.project_material_packs from public, anon, authenticated;
grant select on public.project_material_packs to authenticated;

create or replace function public.can_access_material_pack(check_pack_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select exists (
        select 1 from public.project_material_packs p
        where p.id = check_pack_id and (
            public.is_project_owner(p.project_id)
            or exists (
                select 1 from public.room_material_settings s
                join public.rooms r on r.id = s.room_id and r.project_id = p.project_id
                where public.can_access_room(r.id)
                and s.document->'materials' @> jsonb_build_array(jsonb_build_object('pack', p.id::text))
            )
        )
    );
$$;
revoke all on function public.can_access_material_pack(uuid) from public;
grant execute on function public.can_access_material_pack(uuid) to authenticated;
drop policy if exists material_packs_read on public.project_material_packs;
create policy material_packs_read on public.project_material_packs for select to authenticated
    using (public.can_access_material_pack(id));

insert into storage.buckets(id,name,public) values ('material-packs','material-packs',false)
on conflict (id) do update set public = false;

create or replace function public.can_use_material_pack_object(object_name text, writing boolean default false)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
    parts text[] := string_to_array(object_name, '/');
    project uuid;
    pack uuid;
begin
    if coalesce(object_name, '') !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/(materials\.json|textures/[0-9a-f]{64}\.png)$' then return false; end if;
    begin project := parts[1]::uuid; pack := parts[2]::uuid;
    exception when invalid_text_representation then return false; end;
    if public.is_registered_user() and public.is_project_owner(project) then
        if writing then
            -- Published packs cannot be overwritten or partially deleted.
            return not exists(select 1 from public.project_material_packs p where p.id = pack);
        end if;
        return true;
    end if;
    return not writing and exists (
        select 1 from public.project_material_packs p
        where p.id = pack and p.project_id = project and public.can_access_material_pack(pack)
    );
end;
$$;
revoke all on function public.can_use_material_pack_object(text,boolean) from public;
grant execute on function public.can_use_material_pack_object(text,boolean) to authenticated;
create or replace function public.can_cleanup_orphan_material_pack(object_name text, object_owner text)
returns boolean language sql stable security definer set search_path = public as $$
    select public.is_registered_user()
        and (object_owner = auth.uid()::text or public.is_superuser())
        and object_name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/(materials\.json|textures/[0-9a-f]{64}\.png)$'
        and not exists (select 1 from public.projects p where p.id::text = split_part(object_name,'/',1));
$$;
revoke all on function public.can_cleanup_orphan_material_pack(text,text) from public;
grant execute on function public.can_cleanup_orphan_material_pack(text,text) to authenticated;
drop policy if exists material_packs_upload on storage.objects;
drop policy if exists material_packs_read on storage.objects;
drop policy if exists material_packs_cleanup on storage.objects;
create policy material_packs_upload on storage.objects for insert to authenticated
    with check (bucket_id = 'material-packs' and public.can_use_material_pack_object(name,true));
create policy material_packs_read on storage.objects for select to authenticated
    using (bucket_id = 'material-packs' and (public.can_use_material_pack_object(name,false) or public.can_cleanup_orphan_material_pack(name,owner_id::text)));
create policy material_packs_cleanup on storage.objects for delete to authenticated
    using (bucket_id = 'material-packs' and (public.can_use_material_pack_object(name,true) or public.can_cleanup_orphan_material_pack(name,owner_id::text)));

create or replace function public.publish_project_material_pack(p_id uuid, p_project_id uuid, p_name text, p_source_model text, p_material_count integer, p_texture_count integer)
returns uuid language plpgsql security definer set search_path = public as $$
begin
    if not public.is_registered_user() or not public.is_project_owner(p_project_id) then
        raise exception 'Only the project owner can publish a material pack' using errcode = '42501';
    end if;
    if not exists(select 1 from storage.objects where bucket_id = 'material-packs' and name = p_project_id::text || '/' || p_id::text || '/materials.json') then
        raise exception 'Upload the material pack before publishing' using errcode = '22023';
    end if;
    insert into public.project_material_packs(id,project_id,name,source_model,material_count,texture_count,created_by)
        values(p_id,p_project_id,btrim(p_name),coalesce(p_source_model,''),p_material_count,p_texture_count,auth.uid());
    return p_id;
end;
$$;
revoke all on function public.publish_project_material_pack(uuid,uuid,text,text,integer,integer) from public;
grant execute on function public.publish_project_material_pack(uuid,uuid,text,text,integer,integer) to authenticated;
notify pgrst, 'reload schema';
commit;
