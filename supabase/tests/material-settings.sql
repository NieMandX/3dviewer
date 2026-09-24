begin;
insert into auth.users(id,email) values ('00000000-0000-0000-0000-000000000051','material-owner@test.local'),('00000000-0000-0000-0000-000000000052','material-outsider@test.local');
insert into public.projects(id,name,slug,owner_id) values ('10000000-0000-0000-0000-000000000051','Materials','material-test','00000000-0000-0000-0000-000000000051');
insert into public.rooms(id,project_id,slug,owner_id) values ('20000000-0000-0000-0000-000000000051','10000000-0000-0000-0000-000000000051','material-test','00000000-0000-0000-0000-000000000051');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000051","is_anonymous":false}',true);
select public.save_room_material_settings('20000000-0000-0000-0000-000000000051','{"format":"lpmview-materials","version":1,"materials":[]}',0);
do $$ begin
 if (select revision from public.room_material_settings where room_id='20000000-0000-0000-0000-000000000051') <> 1 then raise exception 'Missing saved document'; end if;
 begin
  perform public.save_room_material_settings('20000000-0000-0000-0000-000000000051','{"format":"lpmview-materials","version":1,"materials":[]}',0);
  raise exception 'Stale save was accepted';
 exception when serialization_failure then null; end;
end $$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000052","is_anonymous":false}',true);
do $$ begin
 if (select count(*) from public.room_material_settings) <> 0 then raise exception 'Private room leaked'; end if;
 begin
  perform public.save_room_material_settings('20000000-0000-0000-0000-000000000051','{"format":"lpmview-materials","version":1,"materials":[]}',1);
  raise exception 'Outsider save was accepted';
 exception when insufficient_privilege then null; end;
end $$;
rollback;
