begin;
create function pg_temp.pack_check(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception '%', message; end if; end;
$$;
insert into auth.users(id,email) values
('00000000-0000-0000-0000-000000000061','pack-owner@test.local'),
('00000000-0000-0000-0000-000000000062','pack-outsider@test.local'),
('00000000-0000-0000-0000-000000000063',null);
insert into public.projects(id,name,slug,owner_id) values
('10000000-0000-0000-0000-000000000061','Packs','pack-test','00000000-0000-0000-0000-000000000061'),
('10000000-0000-0000-0000-000000000062','Other','pack-other','00000000-0000-0000-0000-000000000062');
insert into public.rooms(id,project_id,slug,owner_id) values
('20000000-0000-0000-0000-000000000061','10000000-0000-0000-0000-000000000061','pack-test','00000000-0000-0000-0000-000000000061'),
('20000000-0000-0000-0000-000000000062','10000000-0000-0000-0000-000000000061','pack-private','00000000-0000-0000-0000-000000000061');
insert into public.room_members(room_id,project_id,user_id) values
('20000000-0000-0000-0000-000000000061','10000000-0000-0000-0000-000000000061','00000000-0000-0000-0000-000000000063');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000061","email":"pack-owner@test.local","is_anonymous":false}',true);
insert into storage.objects(bucket_id,name,owner_id) values
('material-packs','10000000-0000-0000-0000-000000000061/30000000-0000-0000-0000-000000000061/materials.json','00000000-0000-0000-0000-000000000061'),
('material-packs','10000000-0000-0000-0000-000000000061/30000000-0000-0000-0000-000000000061/textures/' || repeat('a',64) || '.png','00000000-0000-0000-0000-000000000061'),
('material-packs','10000000-0000-0000-0000-000000000061/30000000-0000-0000-0000-000000000062/materials.json','00000000-0000-0000-0000-000000000061');
select public.publish_project_material_pack('30000000-0000-0000-0000-000000000061','10000000-0000-0000-0000-000000000061','Основные','m8.glb',162,127);
select public.publish_project_material_pack('30000000-0000-0000-0000-000000000062','10000000-0000-0000-0000-000000000061','Приватные','m8.glb',2,0);
select pg_temp.pack_check((select count(*)=2 from public.project_material_packs),'Owner cannot list packs');
select pg_temp.pack_check(not public.can_use_material_pack_object('10000000-0000-0000-0000-000000000061/30000000-0000-0000-0000-000000000061/materials.json',true),'Published pack can be overwritten');
select pg_temp.pack_check(not public.can_use_material_pack_object('../materials.json',false),'Traversal accepted');
select pg_temp.pack_check(not public.can_use_material_pack_object('xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx/30000000-0000-0000-0000-000000000061/materials.json',false),'Invalid UUID accepted');
do $$ begin
 begin
  perform public.publish_project_material_pack('30000000-0000-0000-0000-000000000063','10000000-0000-0000-0000-000000000061','Unfinished','m8.glb',1,0);
  raise exception 'Missing manifest was published';
 exception when invalid_parameter_value then null; end;
 begin
  insert into public.project_material_packs(id,project_id,name,material_count,texture_count) values ('30000000-0000-0000-0000-000000000063','10000000-0000-0000-0000-000000000061','Direct',1,0);
  raise exception 'Direct insertion bypassed publication';
 exception when insufficient_privilege then null; end;
end $$;
select public.save_room_material_settings('20000000-0000-0000-0000-000000000062','{"format":"lpmview-materials","version":1,"materials":[{"pack":"30000000-0000-0000-0000-000000000062"}]}',0);

select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000063","is_anonymous":true}',true);
select pg_temp.pack_check((select count(*)=0 from public.project_material_packs),'Guest can browse project library or another room');
select pg_temp.pack_check((select count(*)=0 from storage.objects where bucket_id='material-packs'),'Guest reads unattached pack images');
do $$ begin
 begin
  perform public.publish_project_material_pack('30000000-0000-0000-0000-000000000063','10000000-0000-0000-0000-000000000061','Guest','x',1,0);
  raise exception 'Guest could publish';
 exception when insufficient_privilege then null; end;
end $$;

select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000061","email":"pack-owner@test.local","is_anonymous":false}',true);
select public.save_room_material_settings('20000000-0000-0000-0000-000000000061','{"format":"lpmview-materials","version":1,"materials":[{"model":"m","material":0,"pack":"30000000-0000-0000-0000-000000000061","portable":{}}]}',0);
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000063","is_anonymous":true}',true);
select pg_temp.pack_check((select count(*)=1 from public.project_material_packs),'Guest cannot restore pack attached to own room');
select pg_temp.pack_check((select count(*)=2 from storage.objects where bucket_id='material-packs'),'Guest image access is not limited to attached pack');
select pg_temp.pack_check(not public.can_use_material_pack_object('10000000-0000-0000-0000-000000000062/30000000-0000-0000-0000-000000000061/materials.json',false),'Pack ID bypasses project path');

select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000062","email":"pack-outsider@test.local","is_anonymous":false}',true);
select pg_temp.pack_check((select count(*)=0 from public.project_material_packs),'Other project owner reads library');
select pg_temp.pack_check((select count(*)=0 from storage.objects where bucket_id='material-packs'),'Other project owner reads images');
do $$ begin
 begin
  insert into storage.objects(bucket_id,name) values ('material-packs','10000000-0000-0000-0000-000000000061/30000000-0000-0000-0000-000000000064/materials.json');
  raise exception 'Outsider uploaded to project';
 exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000061","email":"pack-owner@test.local","is_anonymous":false}',true);
delete from storage.objects where bucket_id='material-packs';
select pg_temp.pack_check((select count(*)=3 from storage.objects where bucket_id='material-packs'),'Published assets can be removed');
delete from public.projects where id='10000000-0000-0000-0000-000000000061';
select pg_temp.pack_check((select count(*)=0 from public.project_material_packs),'Project deletion left pack metadata');
select pg_temp.pack_check((select count(*)=3 from storage.objects where bucket_id='material-packs'),'Owner cannot clean files after project deletion');
delete from storage.objects where bucket_id='material-packs';
select pg_temp.pack_check((select count(*)=0 from storage.objects where bucket_id='material-packs'),'Project asset cleanup failed');
rollback;
