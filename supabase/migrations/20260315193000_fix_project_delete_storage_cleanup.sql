create or replace function public.delete_project_model_storage_object()
returns trigger
language plpgsql
security definer
set search_path = public, storage
as $$
declare
    raw_path text;
    bucket text;
    object_name text;
    meta_storage_path text;
begin
    meta_storage_path := coalesce(old.meta ->> 'storagePath', old.meta ->> 'storage_path', '');
    if meta_storage_path <> '' then
        bucket := 'models';
        object_name := ltrim(meta_storage_path, '/');
    elsif old.url is null or old.url = '' then
        return old;
    elsif position('storage://' in old.url) = 1 then
        raw_path := substr(old.url, length('storage://') + 1);
        bucket := split_part(raw_path, '/', 1);
        object_name := substr(raw_path, length(bucket) + 2);
    elsif position('/storage/v1/object/' in old.url) > 0 then
        raw_path := split_part(old.url, '/storage/v1/object/', 2);
        raw_path := split_part(raw_path, '?', 1);
        if raw_path = '' then
            return old;
        end if;
        raw_path := regexp_replace(raw_path, '^(public|sign|authenticated)/', '');
        bucket := split_part(raw_path, '/', 1);
        object_name := substr(raw_path, length(bucket) + 2);
    else
        return old;
    end if;

    if bucket = '' or object_name = '' then
        return old;
    end if;

    begin
        delete from storage.objects
        where bucket_id = bucket
          and name = object_name;
    exception
        when insufficient_privilege then
            null;
    end;

    return old;
end;
$$;

insert into storage.buckets (id, name, public)
values ('models', 'models', false)
on conflict (id) do update
set public = excluded.public;

drop policy if exists "models_upload" on storage.objects;
create policy "models_upload" on storage.objects
for insert to authenticated
with check (bucket_id = 'models');

drop policy if exists "models_read" on storage.objects;
create policy "models_read" on storage.objects
for select to authenticated
using (bucket_id = 'models');

drop policy if exists "models_delete" on storage.objects;
create policy "models_delete" on storage.objects
for delete to authenticated
using (
    bucket_id = 'models'
    and (
        public.is_superuser()
        or coalesce(owner_id::text, '') = auth.uid()::text
        or (
            coalesce(array_length(storage.foldername(name), 1), 0) >= 2
            and (storage.foldername(name))[1] = 'projects'
            and exists (
                select 1
                from public.project_members pm
                where pm.user_id = auth.uid()
                  and pm.project_id::text = (storage.foldername(name))[2]
            )
        )
    )
);
