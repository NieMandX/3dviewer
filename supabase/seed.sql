insert into storage.buckets (id, name, public)
values ('models', 'models', false)
on conflict (id) do update
set public = excluded.public;
