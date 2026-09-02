begin;
create function pg_temp.check_true(actual boolean, message text) returns void language plpgsql as $$
begin
    if actual is distinct from true then raise exception '%', message; end if;
end;
$$;
create function pg_temp.denied(statement text) returns void language plpgsql as $$
begin
    begin
        execute statement;
    exception when insufficient_privilege then return;
    end;
    raise exception 'Expected permission denial: %', statement;
end;
$$;
create function pg_temp.affects(statement text, expected integer) returns void language plpgsql as $$
declare affected integer;
begin
    execute statement;
    get diagnostics affected = row_count;
    perform pg_temp.check_true(affected = expected, 'Unexpected row count: ' || statement);
end;
$$;

insert into auth.users (id, email) values
('00000000-0000-0000-0000-000000000001','owner-a@example.com'),
('00000000-0000-0000-0000-000000000002','owner-b@example.com'),
('00000000-0000-0000-0000-000000000003','admin@example.com'),
('00000000-0000-0000-0000-000000000004',null);
insert into public.user_roles (user_id,role) values ('00000000-0000-0000-0000-000000000003','superuser');
insert into public.projects (id,name,slug,owner_id) values
('10000000-0000-0000-0000-000000000001','Project A','project-a','00000000-0000-0000-0000-000000000001'),
('10000000-0000-0000-0000-000000000002','Project B','project-b','00000000-0000-0000-0000-000000000002');
insert into public.rooms (id,project_id,slug,owner_id) values
('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','room-a','00000000-0000-0000-0000-000000000001'),
('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','room-a-private','00000000-0000-0000-0000-000000000001'),
('20000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000002','room-b','00000000-0000-0000-0000-000000000002');
insert into public.room_invites(room_id,project_id,token,created_by) values
('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','test-invite-a','00000000-0000-0000-0000-000000000001');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","email":"owner-a@example.com","is_anonymous":false}',true);
select pg_temp.check_true((select count(*)=1 from public.projects),'Owner sees foreign projects');
select pg_temp.check_true((select count(*)=2 from public.rooms),'Owner sees foreign rooms');
select pg_temp.check_true((select count(*)=1 from public.project_admin_owners()),'Owner directory leaks other owners');
select pg_temp.denied($q$select public.join_project_by_slug('project-b','room-b')$q$);
select pg_temp.denied($q$insert into public.rooms(project_id,slug,owner_id) values ('10000000-0000-0000-0000-000000000002','intruder','00000000-0000-0000-0000-000000000001')$q$);
select pg_temp.affects($q$delete from public.projects where slug='project-b'$q$,0);
select pg_temp.denied($q$update public.rooms set owner_id='00000000-0000-0000-0000-000000000002' where slug='room-a'$q$);
select pg_temp.denied($q$update public.rooms set project_id='10000000-0000-0000-0000-000000000002' where slug='room-a'$q$);
insert into public.projects(name,slug,owner_id) values ('Empty','empty','00000000-0000-0000-0000-000000000001');
select pg_temp.check_true((select count(*)=2 from public.projects),'Owner cannot see newly created empty project');
select pg_temp.affects($q$update public.projects set name='Renamed' where slug='empty'$q$,1);
select pg_temp.affects($q$delete from public.projects where slug='empty'$q$,1);

select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000004","is_anonymous":true}',true);
select pg_temp.check_true((select count(*)=0 from public.projects),'Guest sees projects without invite');
select pg_temp.denied($q$select public.join_project_by_slug('project-a','room-a')$q$);
select pg_temp.denied($q$insert into public.user_roles(user_id,role) values ('00000000-0000-0000-0000-000000000004','superuser')$q$);
select public.join_room_by_invite('test-invite-a');
select pg_temp.check_true((select count(*)=1 from public.projects),'Invite reveals unrelated projects');
select pg_temp.check_true((select count(*)=1 from public.rooms),'Invite reveals other rooms in the same project');
select pg_temp.check_true((select count(*)=0 from public.project_admin_owners()),'Guest can read owner emails');
select public.join_project_by_slug('project-a','room-a');
select pg_temp.denied($q$select public.join_project_by_slug('project-a','room-a-private')$q$);
select pg_temp.denied($q$insert into public.projects(name,slug,owner_id) values ('Guest','guest','00000000-0000-0000-0000-000000000004')$q$);
select pg_temp.denied($q$insert into public.project_models(project_id,name,url) values ('10000000-0000-0000-0000-000000000001','forbidden','storage://models/test')$q$);
select pg_temp.denied($q$insert into storage.objects(bucket_id,name) values ('models','projects/10000000-0000-0000-0000-000000000001/test.zip')$q$);
select pg_temp.affects($q$delete from public.rooms where slug='room-a'$q$,0);
insert into public.annotations(room_id,author_id,author_name,kind,payload) values
('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000004','Guest','pin','{}');
insert into public.messages(room_id,author_id,author_name,body) values
('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000004','Guest','test');
insert into public.room_cameras(room_id,name,position,target) values
('20000000-0000-0000-0000-000000000001','Guest camera','[]','[]');

select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000003","email":"admin@example.com","is_anonymous":false}',true);
select pg_temp.check_true(public.is_superuser(),'Admin role not recognized');
select pg_temp.check_true((select count(*)=2 from public.projects),'Admin cannot see all projects');
select pg_temp.check_true((select count(*)=3 from public.rooms),'Admin cannot see all rooms');
select pg_temp.check_true((select count(*)=2 from public.project_admin_owners()),'Admin owner directory incomplete');
insert into public.rooms(project_id,slug,owner_id) values
('10000000-0000-0000-0000-000000000002','admin-created','00000000-0000-0000-0000-000000000003');
select pg_temp.check_true((select owner_id='00000000-0000-0000-0000-000000000002' from public.rooms where slug='admin-created'),'Admin stole room ownership when creating it');
select pg_temp.affects($q$update public.rooms set slug='renamed' where slug='admin-created'$q$,1);
select pg_temp.affects($q$delete from public.rooms where slug='renamed'$q$,1);
select pg_temp.affects($q$delete from public.projects where slug='project-a'$q$,1);
select pg_temp.check_true((select count(*)=0 from public.annotations),'Annotations survived deleted project');
select pg_temp.check_true((select count(*)=0 from public.messages),'Messages survived deleted project');
select pg_temp.check_true((select count(*)=0 from public.room_cameras),'Cameras survived deleted project');
rollback;
