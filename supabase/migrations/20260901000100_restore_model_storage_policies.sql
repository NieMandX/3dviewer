begin;

alter table storage.objects enable row level security;

grant execute on function public.can_upload_model_storage_object(text) to authenticated;
grant execute on function public.can_access_model_storage_object(text) to authenticated;

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

commit;
