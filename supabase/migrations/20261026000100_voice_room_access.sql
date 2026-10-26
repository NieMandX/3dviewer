begin;
-- Only the trusted voice service may check another user's current room access.
-- Reuse the existing policy helpers; never duplicate ownership/invite rules.
create function public.check_voice_room_access(check_room_id uuid, check_user_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare
    previous_claims text := current_setting('request.jwt.claims',true);
    previous_sub text := current_setting('request.jwt.claim.sub',true);
    previous_role text := current_setting('request.jwt.claim.role',true);
    allowed boolean;
begin
    if not exists (select 1 from auth.users u where u.id=check_user_id
        and to_jsonb(u)->>'deleted_at' is null
        and coalesce((to_jsonb(u)->>'banned_until')::timestamptz,'-infinity') <= statement_timestamp()) then
        return false;
    end if;
    perform set_config('request.jwt.claims',jsonb_build_object('sub',check_user_id,'role','authenticated')::text,true);
    perform set_config('request.jwt.claim.sub',check_user_id::text,true);
    perform set_config('request.jwt.claim.role','authenticated',true);
    select exists(select 1 from public.rooms where id=check_room_id)
        and public.can_access_room(check_room_id) into allowed;
    perform set_config('request.jwt.claims',coalesce(previous_claims,''),true);
    perform set_config('request.jwt.claim.sub',coalesce(previous_sub,''),true);
    perform set_config('request.jwt.claim.role',coalesce(previous_role,''),true);
    return coalesce(allowed,false);
exception when others then
    perform set_config('request.jwt.claims',coalesce(previous_claims,''),true);
    perform set_config('request.jwt.claim.sub',coalesce(previous_sub,''),true);
    perform set_config('request.jwt.claim.role',coalesce(previous_role,''),true);
    raise;
end;
$$;
revoke all on function public.check_voice_room_access(uuid,uuid) from public,anon,authenticated;
grant execute on function public.check_voice_room_access(uuid,uuid) to service_role;
notify pgrst,'reload schema';
commit;
