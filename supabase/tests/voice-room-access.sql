begin;
create function pg_temp.assert_voice(actual boolean,message text) returns void language plpgsql as $$
begin if actual is distinct from true then raise exception '%',message; end if; end; $$;
insert into auth.users(id,email) values
('60000000-0000-0000-0000-000000000001','voice-owner@example.invalid'),
('60000000-0000-0000-0000-000000000002',null),
('60000000-0000-0000-0000-000000000003','voice-outsider@example.invalid');
insert into public.projects(id,name,slug,owner_id) values
('61000000-0000-0000-0000-000000000001','Voice test','voice-access-test','60000000-0000-0000-0000-000000000001');
insert into public.rooms(id,project_id,slug,owner_id) values
('62000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000001','voice','60000000-0000-0000-0000-000000000001');
insert into public.room_members(room_id,project_id,user_id) values
('62000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000002');

select pg_temp.assert_voice(not has_function_privilege('anon','public.check_voice_room_access(uuid,uuid)','EXECUTE'),'Anon can impersonate a user');
select pg_temp.assert_voice(not has_function_privilege('authenticated','public.check_voice_room_access(uuid,uuid)','EXECUTE'),'User can impersonate another user');
select pg_temp.assert_voice(has_function_privilege('service_role','public.check_voice_room_access(uuid,uuid)','EXECUTE'),'Service cannot check access');
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role","sub":"60000000-0000-0000-0000-000000000003"}',true);
select set_config('request.jwt.claim.sub','60000000-0000-0000-0000-000000000003',true);
select set_config('request.jwt.claim.role','service_role',true);
select pg_temp.assert_voice(public.check_voice_room_access('62000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001'),'Owner denied');
select pg_temp.assert_voice(public.check_voice_room_access('62000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000002'),'Guest denied');
select pg_temp.assert_voice(not public.check_voice_room_access('62000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000003'),'Outsider allowed');
select pg_temp.assert_voice(auth.uid()='60000000-0000-0000-0000-000000000003','Caller subject was not restored');
select pg_temp.assert_voice(auth.jwt()->>'role'='service_role' and current_setting('request.jwt.claim.role')='service_role','Caller role was not restored');
reset role;
delete from public.room_members where user_id='60000000-0000-0000-0000-000000000002';
select pg_temp.assert_voice(not public.check_voice_room_access('62000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000002'),'Revoked guest allowed');
insert into public.user_roles(user_id,role) values('60000000-0000-0000-0000-000000000003','superuser');
select pg_temp.assert_voice(public.check_voice_room_access('62000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000003'),'Superuser denied');
update auth.users set banned_until=now()+interval '1 hour' where id='60000000-0000-0000-0000-000000000003';
select pg_temp.assert_voice(not public.check_voice_room_access('62000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000003'),'Banned superuser allowed');
update auth.users set banned_until=null,deleted_at=now() where id='60000000-0000-0000-0000-000000000003';
select pg_temp.assert_voice(not public.check_voice_room_access('62000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000003'),'Deleted superuser allowed');
update auth.users set deleted_at=null where id='60000000-0000-0000-0000-000000000003';
delete from public.rooms where id='62000000-0000-0000-0000-000000000001';
select pg_temp.assert_voice(not public.check_voice_room_access('62000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001'),'Owner allowed into deleted room');
select pg_temp.assert_voice(not public.check_voice_room_access('62000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000003'),'Superuser allowed into deleted room');
select pg_temp.assert_voice(not public.check_voice_room_access(null,null),'NULL access allowed');
rollback;
