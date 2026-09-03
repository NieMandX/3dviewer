begin;
create function pg_temp.denied(statement text) returns void language plpgsql as $$
begin
    begin
        execute statement;
    exception when insufficient_privilege then return;
    end;
    raise exception 'Expected permission denial: %', statement;
end;
$$;
create function pg_temp.check_true(actual boolean, message text) returns void language plpgsql as $$
begin
    if actual is distinct from true then raise exception '%', message; end if;
end;
$$;

insert into public.integration_secrets (name, secret_value)
values ('2gis_api_key', 'server-only-test-value');

set local role anon;
select pg_temp.denied($q$select * from public.integration_secrets$q$);
select pg_temp.denied($q$insert into public.integration_secrets(name,secret_value) values ('x','client')$q$);

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000003","email":"admin@example.com","is_anonymous":false}',true);
select pg_temp.denied($q$select * from public.integration_secrets$q$);
select pg_temp.denied($q$update public.integration_secrets set secret_value='leaked' where name='2gis_api_key'$q$);
select pg_temp.denied($q$delete from public.integration_secrets where name='2gis_api_key'$q$);

set local role service_role;
select pg_temp.check_true((select secret_value = 'server-only-test-value'
    from public.integration_secrets where name = '2gis_api_key'), 'Service role cannot read secret');
update public.integration_secrets set secret_value='server-updated' where name='2gis_api_key';
select pg_temp.check_true((select secret_value = 'server-updated'
    from public.integration_secrets where name = '2gis_api_key'), 'Service role cannot update secret');
delete from public.integration_secrets where name='2gis_api_key';
select pg_temp.check_true((select count(*) = 0 from public.integration_secrets), 'Service role cannot delete secret');

rollback;
