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

insert into auth.users (id, email, created_at, email_confirmed_at, is_anonymous, deleted_at) values
('00000000-0000-0000-0000-000000000001','owner@example.com','2026-01-01',now(),false,null),
('00000000-0000-0000-0000-000000000002','admin@example.com','2026-01-01',now(),false,null),
('00000000-0000-0000-0000-000000000003','empty@example.com','2026-01-01',null,false,null),
('00000000-0000-0000-0000-000000000004',null,'2026-01-01',null,true,null),
('00000000-0000-0000-0000-000000000005','anonymous@example.com','2026-01-01',null,true,null),
('00000000-0000-0000-0000-000000000006','deleted@example.com','2026-01-01',now(),false,now());
insert into public.user_roles (user_id,role) values ('00000000-0000-0000-0000-000000000002','superuser');
insert into public.profiles (id,display_name) values ('00000000-0000-0000-0000-000000000003','New user 100%_');
insert into public.projects (name,slug,owner_id) values ('Owned','owned','00000000-0000-0000-0000-000000000001');

set local role anon;
select pg_temp.denied($q$select public.admin_list_registered_users()$q$);
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","email":"owner@example.com","is_anonymous":false,"user_metadata":{"role":"superuser"}}',true);
select pg_temp.denied($q$select public.admin_list_registered_users()$q$);
select pg_temp.denied($q$select * from auth.users$q$);
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000004","is_anonymous":true}',true);
select pg_temp.denied($q$select public.admin_list_registered_users()$q$);
select set_config('request.jwt.claims','{}',true);
select pg_temp.denied($q$select public.admin_list_registered_users()$q$);

select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000002","email":"admin@example.com","is_anonymous":false}',true);
select pg_temp.check_true(public.admin_list_registered_users()->>'total' = '3','Registered list excludes empty accounts or includes anonymous/deleted');
select pg_temp.check_true(public.admin_list_registered_users()->'users'->0->>'user_id' = '00000000-0000-0000-0000-000000000001','Sort is not deterministic');
select pg_temp.check_true(public.admin_list_registered_users('',1,1)->'users'->0->>'role' = 'superuser','Role or offset incorrect');
select pg_temp.check_true(public.admin_list_registered_users('  EMPTY@EXAMPLE.COM  ')->>'total' = '1','Email search is not trimmed/case-insensitive');
select pg_temp.check_true(public.admin_list_registered_users('NEW USER')->>'total' = '1','Display name search failed');
select pg_temp.check_true(public.admin_list_registered_users('%_')->>'total' = '1','Search wildcard escaping failed');
select pg_temp.check_true(public.admin_list_registered_users('missing') = '{"total":0,"users":[]}'::jsonb,'Empty search response incorrect');
select pg_temp.check_true(public.admin_list_registered_users('',99,50) = '{"total":3,"users":[]}'::jsonb,'Empty page loses total');
select pg_temp.check_true(jsonb_array_length(public.admin_list_registered_users('',-10,0)->'users')=1,'Negative offset or minimum limit incorrect');
select pg_temp.check_true(public.admin_list_registered_users('empty')->'users'->0->>'email_confirmed' = 'false','Unconfirmed account excluded or mislabeled');
select pg_temp.check_true((select array_agg(k order by k) = array['created_at','display_name','email','email_confirmed','last_sign_in_at','role','user_id'] from jsonb_object_keys(public.admin_list_registered_users()->'users'->0) k),'Unexpected Auth fields exposed');
select pg_temp.denied($q$select * from auth.users$q$);

reset role;
insert into auth.users(id,email) select gen_random_uuid(),'page-'||n||'@example.com' from generate_series(1,110) n;
set local role authenticated;
select pg_temp.check_true(jsonb_array_length(public.admin_list_registered_users()->'users')=50,'Default limit not applied');
select pg_temp.check_true(jsonb_array_length(public.admin_list_registered_users('',0,100000)->'users')=100,'Server page cap not applied');
reset role;
update auth.users set deleted_at=now() where email='admin@example.com';
set local role authenticated;
select pg_temp.denied($q$select public.admin_list_registered_users()$q$);
reset role;
update auth.users set deleted_at=null where email='admin@example.com';
delete from public.user_roles where role='superuser';
set local role authenticated;
select pg_temp.denied($q$select public.admin_list_registered_users()$q$);
rollback;
