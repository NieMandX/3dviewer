-- Read-only account directory. Never expose Auth tables or admin credentials to clients.
create or replace function public.admin_list_registered_users(
    search_text text default '', page_offset integer default 0, page_size integer default 50
)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
    result jsonb;
    query text := lower(left(btrim(coalesce(search_text, '')), 200));
begin
    if not coalesce(public.is_registered_user() and public.is_superuser(), false)
        or not exists (
            select 1 from auth.users u where u.id = auth.uid()
                and not coalesce(u.is_anonymous, false) and u.deleted_at is null
                and nullif(btrim(u.email), '') is not null
        ) then
        raise exception 'superuser access required' using errcode = '42501';
    end if;

    with registered as (
        select u.id as user_id, u.email::text, p.display_name,
            case when exists (select 1 from public.user_roles r
                where r.user_id = u.id and r.role = 'superuser')
                then 'superuser' else 'user' end as role,
            u.created_at, u.last_sign_in_at, (u.email_confirmed_at is not null) as email_confirmed
        from auth.users u left join public.profiles p on p.id = u.id
        where not coalesce(u.is_anonymous, false) and u.deleted_at is null
            and nullif(btrim(u.email), '') is not null
            and (query = '' or strpos(lower(u.email), query) > 0
                or strpos(lower(coalesce(p.display_name, '')), query) > 0)
    ), page as (
        select * from registered
        order by created_at desc nulls last, user_id
        limit least(100, greatest(1, coalesce(page_size, 50)))
        offset greatest(0, coalesce(page_offset, 0))
    )
    select jsonb_build_object(
        'total', (select count(*) from registered),
        'users', coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at desc nulls last, p.user_id)
            from page p), '[]'::jsonb)
    ) into result;
    return result;
end;
$$;
revoke all on function public.admin_list_registered_users(text, integer, integer) from public, anon;
grant execute on function public.admin_list_registered_users(text, integer, integer) to authenticated;
notify pgrst, 'reload schema';
