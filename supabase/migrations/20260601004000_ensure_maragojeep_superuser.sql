insert into public.user_roles (user_id, role)
select id, 'superuser'
from auth.users
where lower(email) = 'maragojeep@gmail.com'
on conflict (user_id, role) do nothing;
