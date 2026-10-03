begin;
create function pg_temp.assert_check(actual boolean,message text) returns void language plpgsql as $$
begin if actual is distinct from true then raise exception '%',message; end if; end; $$;
create function pg_temp.expect_error(statement text,wanted text) returns void language plpgsql as $$
begin
    begin execute statement;
    exception when others then if sqlstate=wanted then return; end if;raise; end;
    raise exception 'Expected SQLSTATE %: %',wanted,statement;
end; $$;
insert into public.model_check_engines(revision,checker_version,image_id,wrapper_sha256,enabled) values('test161','1.6.1','sha256:'||repeat('1',64),repeat('2',64),true);
insert into auth.users(id,email) values
('00000000-0000-0000-0000-000000000001','owner-a@example.com'),
('00000000-0000-0000-0000-000000000002','owner-b@example.com'),
('00000000-0000-0000-0000-000000000003','admin@example.com'),
('00000000-0000-0000-0000-000000000004',null);
insert into public.user_roles(user_id,role) values('00000000-0000-0000-0000-000000000003','superuser');
insert into public.projects(id,name,slug,owner_id) values
('10000000-0000-0000-0000-000000000001','A','checks-a','00000000-0000-0000-0000-000000000001'),
('10000000-0000-0000-0000-000000000002','B','checks-b','00000000-0000-0000-0000-000000000002');
insert into public.rooms(id,project_id,slug,owner_id) values
('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','shared','00000000-0000-0000-0000-000000000001');
insert into public.room_members(room_id,project_id,user_id) values('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000004');
insert into public.project_models(id,project_id,name,url) values
('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','SM_Model_001.zip','storage://models/projects/10000000-0000-0000-0000-000000000001/test.zip'),
('30000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','context.glb','storage://models/projects/10000000-0000-0000-0000-000000000001/context.glb'),
('30000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000002','other.zip','storage://models/projects/10000000-0000-0000-0000-000000000002/other.zip');
insert into public.room_models(room_id,project_id,model_id) values('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001');
insert into storage.objects(bucket_id,name) values
('models','projects/10000000-0000-0000-0000-000000000001/test.zip'),
('models','projects/10000000-0000-0000-0000-000000000001/context.glb'),
('models','projects/10000000-0000-0000-0000-000000000002/other.zip');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","is_anonymous":false}',true);
select pg_temp.expect_error($q$select public.claim_model_check('test161')$q$,'42501');
select pg_temp.expect_error($q$select * from public.model_check_leases$q$,'42501');
select pg_temp.expect_error($q$select public.model_check_source('30000000-0000-0000-0000-000000000001')$q$,'42501');
select pg_temp.expect_error($q$select public.request_model_check('30000000-0000-0000-0000-000000000002')$q$,'22023');
select pg_temp.expect_error($q$select public.request_model_check('30000000-0000-0000-0000-000000000003')$q$,'42501');
select public.request_model_check('30000000-0000-0000-0000-000000000001');
select public.request_model_check('30000000-0000-0000-0000-000000000001');
select pg_temp.assert_check((select count(*)=1 from public.model_check_jobs),'Duplicate request created two jobs');
select pg_temp.expect_error($q$update public.model_check_jobs set status='completed'$q$,'42501');
select pg_temp.expect_error($q$insert into public.model_check_jobs(model_id,project_id,source_name,source_path,source_revision) values('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','forged.zip','fake','fake')$q$,'42501');
select pg_temp.assert_check((select (public.get_model_check(id)->>'source_current')::boolean from public.model_check_jobs),'Fresh source not current');
select pg_temp.assert_check((select not(public.get_model_check(id)?'report') from public.model_check_jobs),'Polling includes report body');

-- Invited guests may read this room's report, but cannot spend worker capacity/cancel.
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000004","is_anonymous":true}',true);
select pg_temp.assert_check((select count(*)=1 from public.model_check_jobs),'Invited guest cannot read linked model job');
select public.get_model_check(id) from public.model_check_jobs;
select pg_temp.expect_error($q$select public.request_model_check('30000000-0000-0000-0000-000000000001')$q$,'42501');
select pg_temp.expect_error($q$select public.cancel_model_check(id) from public.model_check_jobs$q$,'42501');
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000002","is_anonymous":false}',true);
select pg_temp.assert_check((select count(*)=0 from public.model_check_jobs),'Foreign owner sees model check');

reset role;
create temp table claimed(value jsonb);
grant all on claimed to service_role;
set local role service_role;
insert into claimed select public.claim_model_check('test161');
select pg_temp.assert_check((select value->'job'->>'status'='running' from claimed),'Claim failed');
select pg_temp.assert_check(public.claim_model_check('test161') is null,'Job claimed twice');
select pg_temp.assert_check((select public.heartbeat_model_check((value->'job'->>'id')::uuid,gen_random_uuid(),'blender_checks')->>'active'='false' from claimed),'Wrong lease can heartbeat');
select pg_temp.assert_check((select public.heartbeat_model_check((value->'job'->>'id')::uuid,(value->>'lease_token')::uuid,'blender_checks')->>'active'='true' from claimed),'Valid heartbeat failed');
select pg_temp.expect_error($q$select public.finish_model_check((value->'job'->>'id')::uuid,(value->>'lease_token')::uuid,'completed',repeat('a',64),'{}') from claimed$q$,'22023');
select pg_temp.assert_check((select public.finish_model_check((value->'job'->>'id')::uuid,(value->>'lease_token')::uuid,'completed',repeat('a',64),
    jsonb_build_object('source_sha256',repeat('a',64),'checker_version','1.6.1','ruleset_id','moscow-npm-vpm-2026-08-18','status','completed','input_unchanged',true,'worker_provenance',jsonb_build_object('image_id','sha256:'||repeat('1',64),'wrapper_sha256',repeat('2',64)),'summary','{"failed":2,"not_checked":53}'::jsonb)) from claimed),'Valid report failed');
select pg_temp.assert_check((select count(*)=0 from public.model_check_leases),'Finished lease survived');
select pg_temp.assert_check((select not public.finish_model_check((value->'job'->>'id')::uuid,(value->>'lease_token')::uuid,'incomplete') from claimed),'Stale worker overwrote completed job');
reset role;
-- Same path, new Storage version: old report is historical, next request creates a new job.
update storage.objects set version='replaced-version' where name like '%/test.zip';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","is_anonymous":false}',true);
select pg_temp.assert_check((select not(public.get_model_check(id)->>'source_current')::boolean from public.model_check_jobs),'Replaced ZIP kept a current report');
select public.request_model_check('30000000-0000-0000-0000-000000000001');
select pg_temp.assert_check((select count(*)=2 from public.model_check_jobs),'Source replacement reused old report');
select public.cancel_model_check(id) from public.model_check_jobs where status='queued';
select pg_temp.assert_check((select count(*)=1 from public.model_check_jobs where status='cancelled'),'Queued cancellation failed');
select public.request_model_check('30000000-0000-0000-0000-000000000001');
reset role;
truncate claimed;
set local role service_role;
insert into claimed select public.claim_model_check('test161');
reset role;
set local role authenticated;
select public.cancel_model_check(id) from public.model_check_jobs where status='running';
reset role;
set local role service_role;
select pg_temp.assert_check((select public.finish_model_check((value->'job'->>'id')::uuid,(value->>'lease_token')::uuid,'completed',repeat('a',64),'{}') from claimed),'Cancel did not win success race');
select pg_temp.assert_check((select status='cancelled' and report is null from public.model_check_jobs where id=(select (value->'job'->>'id')::uuid from claimed)),'Cancelled result published');
reset role;
-- An expired lease cannot renew or publish; next claim marks it incomplete.
set local role authenticated;
select public.request_model_check('30000000-0000-0000-0000-000000000001');
reset role;
truncate claimed;
set local role service_role;
insert into claimed select public.claim_model_check('test161');
update public.model_check_leases set expires_at=clock_timestamp()-interval '1 second';
select pg_temp.assert_check((select public.heartbeat_model_check((value->'job'->>'id')::uuid,(value->>'lease_token')::uuid,'blender_checks')->>'active'='false' from claimed),'Expired lease renewed');
select pg_temp.assert_check((select not public.finish_model_check((value->'job'->>'id')::uuid,(value->>'lease_token')::uuid,'incomplete') from claimed),'Expired lease published');
select public.claim_model_check('test161');
select pg_temp.assert_check((select status='incomplete' and error_code='worker_lease_expired' from public.model_check_jobs where id=(select (value->'job'->>'id')::uuid from claimed)),'Expired execution not retired');
reset role;
-- Replacing the object during execution cancels work and invalidates completion.
set local role authenticated;
select public.request_model_check('30000000-0000-0000-0000-000000000001');
reset role;
truncate claimed;
set local role service_role;
insert into claimed select public.claim_model_check('test161');
reset role;
update storage.objects set version='changed-during-check' where name like '%/test.zip';
set local role service_role;
select pg_temp.assert_check((select public.heartbeat_model_check((value->'job'->>'id')::uuid,(value->>'lease_token')::uuid,'blender_checks')->>'cancel_requested'='true' from claimed),'Changed source kept executing');
select pg_temp.assert_check((select public.finish_model_check((value->'job'->>'id')::uuid,(value->>'lease_token')::uuid,'completed',repeat('a',64),'{}') from claimed),'Changed source did not finalize');
select pg_temp.assert_check((select status='incomplete' and report is null and error_code='source_changed' from public.model_check_jobs where id=(select (value->'job'->>'id')::uuid from claimed)),'Changed source published stale success');
reset role;
-- An engine identity is immutable and a new engine cannot reuse an old job.
select pg_temp.expect_error($q$update public.model_check_engines set wrapper_sha256=repeat('9',64) where revision='test161'$q$,'22023');
set local role authenticated;
select pg_temp.expect_error($q$select * from public.model_check_engines$q$,'42501');
select public.request_model_check('30000000-0000-0000-0000-000000000001');
reset role;
update public.model_check_engines set enabled=false;
set local role authenticated;
select pg_temp.expect_error($q$select public.request_model_check('30000000-0000-0000-0000-000000000001')$q$,'55000');
reset role;
insert into public.model_check_engines(revision,checker_version,image_id,wrapper_sha256,enabled) values('test161-next','1.6.1','sha256:'||repeat('3',64),repeat('4',64),true);
set local role authenticated;
select public.request_model_check('30000000-0000-0000-0000-000000000001');
select pg_temp.assert_check((select count(distinct engine_revision)=2 from public.model_check_jobs where status='queued'),'New engine reused old job');
select pg_temp.assert_check((select bool_and(not (public.get_model_check(id)->>'engine_current')::boolean) from public.model_check_jobs where engine_revision='test161'),'Retired engine marked current');
select pg_temp.assert_check((select (public.get_model_check(id)->>'engine_current')::boolean from public.model_check_jobs where engine_revision='test161-next'),'Active engine marked stale');
reset role;
truncate claimed;
set local role service_role;
insert into claimed select public.claim_model_check('test161-next');
select pg_temp.assert_check((select value->'job'->>'engine_revision'='test161-next' from claimed),'Worker claimed another engine revision');
select pg_temp.assert_check((select public.finish_model_check((value->'job'->>'id')::uuid,(value->>'lease_token')::uuid,'not_applicable',repeat('a',64),
 jsonb_build_object('source_sha256',repeat('a',64),'checker_version','1.6.1','ruleset_id','moscow-npm-vpm-2026-08-18','status','not_applicable','input_unchanged',true,
 'worker_provenance',jsonb_build_object('image_id','sha256:'||repeat('3',64),'wrapper_sha256',repeat('4',64)))) from claimed),'Env exclusion did not finalize');
select pg_temp.assert_check((select status='not_applicable' and report is null and source_sha256=repeat('a',64) from public.model_check_jobs where id=(select (value->'job'->>'id')::uuid from claimed)),'Env exclusion created a compliance report');
reset role;
-- Quota is per project, including different revisions of one uploaded file.
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000002","is_anonymous":false}',true);
update storage.objects set version='quota-0' where name like '%/other.zip';
set local role authenticated;
select public.request_model_check('30000000-0000-0000-0000-000000000003');
reset role;
update storage.objects set version='quota-1' where name like '%/other.zip';
set local role authenticated;
select public.request_model_check('30000000-0000-0000-0000-000000000003');
reset role;
update storage.objects set version='quota-2' where name like '%/other.zip';
set local role authenticated;
select public.request_model_check('30000000-0000-0000-0000-000000000003');
reset role;
update storage.objects set version='quota-3' where name like '%/other.zip';
set local role authenticated;
select public.request_model_check('30000000-0000-0000-0000-000000000003');
reset role;
update storage.objects set version='quota-rejected' where name like '%/other.zip';
set local role authenticated;
select pg_temp.expect_error($q$select public.request_model_check('30000000-0000-0000-0000-000000000003')$q$,'54000');
reset role;
delete from public.model_check_jobs where project_id='10000000-0000-0000-0000-000000000002';
-- Revocation immediately hides historical reports.
delete from public.room_members where user_id='00000000-0000-0000-0000-000000000004';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000004","is_anonymous":true}',true);
select pg_temp.assert_check((select count(*)=0 from public.model_check_jobs),'Revoked guest retains report access');
reset role;
-- Cross-project path substitution cannot turn a record into a foreign download.
update public.project_models set meta='{"storagePath":"projects/10000000-0000-0000-0000-000000000002/other.zip"}' where id='30000000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","is_anonymous":false}',true);
select pg_temp.expect_error($q$select public.request_model_check('30000000-0000-0000-0000-000000000001')$q$,'22023');
reset role;
delete from public.projects where id='10000000-0000-0000-0000-000000000001';
select pg_temp.assert_check((select count(*)=0 from public.model_check_jobs),'Deleted project kept reports');
rollback;
