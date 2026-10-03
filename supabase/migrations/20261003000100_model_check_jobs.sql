-- Queue only. Does not install Blender, enable a public endpoint or modify Storage.
begin;
create table public.model_check_engines (
    revision text primary key check (length(revision) between 1 and 100),
    checker_version text not null check (checker_version='1.6.1'),
    image_id text not null check (image_id ~ '^sha256:[0-9a-f]{64}$'),
    wrapper_sha256 text not null check (wrapper_sha256 ~ '^[0-9a-f]{64}$'),
    enabled boolean not null default false
);
create unique index model_check_engine_active on public.model_check_engines((true)) where enabled;
alter table public.model_check_engines enable row level security;
revoke all on public.model_check_engines from public,anon,authenticated;
grant all on public.model_check_engines to service_role;
create function public.protect_model_check_engine() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
    if (new.revision,new.checker_version,new.image_id,new.wrapper_sha256) is distinct from
       (old.revision,old.checker_version,old.image_id,old.wrapper_sha256) then
        raise exception 'Register a new checker engine revision instead of changing its identity' using errcode='22023';
    end if;
    return new;
end;
$$;
create trigger model_check_engine_immutable before update on public.model_check_engines
    for each row execute function public.protect_model_check_engine();

create table public.model_check_jobs (
    id uuid primary key default gen_random_uuid(),
    model_id uuid not null,
    project_id uuid not null,
    requested_by uuid references auth.users(id) on delete set null,
    source_name text not null,
    source_path text not null,
    source_revision text not null,
    source_sha256 text check (source_sha256 ~ '^[0-9a-f]{64}$'),
    engine_revision text not null references public.model_check_engines(revision),
    status text not null default 'queued' check (status in ('queued','running','completed','incomplete','cancelled','not_applicable')),
    stage text not null default 'queued',
    cancel_requested boolean not null default false,
    summary jsonb,
    report jsonb,
    error_code text,
    created_at timestamptz not null default clock_timestamp(),
    updated_at timestamptz not null default clock_timestamp(),
    finished_at timestamptz,
    foreign key (model_id,project_id) references public.project_models(id,project_id) on delete cascade,
    check (report is null or octet_length(report::text) <= 4194304),
    check (status <> 'completed' or (report is not null and source_sha256 is not null))
);
create unique index model_check_jobs_reusable on public.model_check_jobs(model_id,source_revision,engine_revision)
    where status in ('queued','running','completed');
create index model_check_jobs_claim on public.model_check_jobs(created_at,id) where status='queued';
create index model_check_jobs_project on public.model_check_jobs(project_id,created_at desc);
create index model_check_jobs_requester on public.model_check_jobs(requested_by);
alter table public.model_check_jobs enable row level security;
revoke all on public.model_check_jobs from public,anon,authenticated;
grant select on public.model_check_jobs to authenticated;
grant all on public.model_check_jobs to service_role;
create policy model_check_jobs_read on public.model_check_jobs for select to authenticated
    using (public.can_access_project_model(model_id,project_id));

-- Lease tokens must never be exposed through a user's job/report SELECT.
create table public.model_check_leases (
    job_id uuid primary key references public.model_check_jobs(id) on delete cascade,
    token uuid not null default gen_random_uuid(),
    expires_at timestamptz not null
);
create index model_check_leases_expiry on public.model_check_leases(expires_at);
alter table public.model_check_leases enable row level security;
revoke all on public.model_check_leases from public,anon,authenticated;
grant all on public.model_check_leases to service_role;

-- A revision of metadata, NOT the archive's cryptographic content hash.
-- to_jsonb allows Storage releases with version and/or updated_at metadata.
create function public.model_check_source(check_model_id uuid)
returns table(project_id uuid,source_name text,source_path text,source_revision text)
language sql stable security definer set search_path=public,pg_temp as $$
    select m.project_id,m.name,p.path,
        md5(jsonb_build_object('model_updated',m.updated_at,'name',m.name,'path',p.path,
            'storage_id',o.id,'version',to_jsonb(o)->>'version',
            'storage_updated',to_jsonb(o)->>'updated_at','metadata',to_jsonb(o)->'metadata')::text)
    from public.project_models m
    cross join lateral (select coalesce(nullif(m.meta->>'storagePath',''),nullif(m.meta->>'storage_path',''),
        case when m.url like 'storage://models/%' then substr(m.url,18) end) as path) p
    join storage.objects o on o.bucket_id='models' and o.name=p.path
    where m.id=check_model_id
      and p.path like 'projects/'||m.project_id::text||'/%'
      and length(p.path)<=1024
      and p.path !~ '(^|/)\.{1,2}(/|$)|[\\[:cntrl:]]'
      and m.name ~ '\.zip$' and m.name !~ '[/\\[:cntrl:]]'
      and length(m.name) between 5 and 255
      and (to_jsonb(o)->>'version' is not null or to_jsonb(o)->>'updated_at' is not null)
    limit 1;
$$;
revoke all on function public.model_check_source(uuid) from public,anon,authenticated;
grant execute on function public.model_check_source(uuid) to service_role;

create function public.request_model_check(check_model_id uuid)
returns public.model_check_jobs
language plpgsql security definer set search_path=public,pg_temp as $$
declare model public.project_models; source record; job public.model_check_jobs; engine text;
begin
    select * into model from public.project_models where id=check_model_id;
    if auth.uid() is null or model.id is null or not public.is_project_owner(model.project_id) then
        raise exception 'model check requires project ownership' using errcode='42501';
    end if;
    select revision into engine from public.model_check_engines where enabled;
    if engine is null then raise exception 'checker worker is not configured' using errcode='55000'; end if;
    -- Serialize this project's quota and duplicate requests, without a global lock.
    perform 1 from public.projects where id=model.project_id for update;
    select * into source from public.model_check_source(check_model_id);
    if source.source_revision is null then
        raise exception 'a stored ZIP with a verifiable source version is required' using errcode='22023';
    end if;
    select * into job from public.model_check_jobs
        where model_id=check_model_id and source_revision=source.source_revision
          and engine_revision=engine and status in ('queued','running','completed')
        order by created_at desc limit 1;
    if job.id is not null then return job; end if;
    if (select count(*) from public.model_check_jobs where project_id=model.project_id and status in ('queued','running'))>=4 then
        raise exception 'project check queue is full' using errcode='54000';
    end if;
    insert into public.model_check_jobs(model_id,project_id,requested_by,source_name,source_path,source_revision,engine_revision)
        values(check_model_id,model.project_id,auth.uid(),source.source_name,source.source_path,source.source_revision,engine)
        returning * into job;
    return job;
end;
$$;
revoke all on function public.request_model_check(uuid) from public,anon;
grant execute on function public.request_model_check(uuid) to authenticated;

create function public.cancel_model_check(check_job_id uuid)
returns public.model_check_jobs
language plpgsql security definer set search_path=public,pg_temp as $$
declare job public.model_check_jobs;
begin
    select * into job from public.model_check_jobs where id=check_job_id for update;
    if auth.uid() is null or job.id is null or not public.is_project_owner(job.project_id) then
        raise exception 'model check requires project ownership' using errcode='42501';
    end if;
    if job.status in ('queued','running') then
        update public.model_check_jobs set cancel_requested=true,
            status=case when status='queued' then 'cancelled' else status end,
            stage=case when status='queued' then 'cancelled' else stage end,
            finished_at=case when status='queued' then clock_timestamp() else finished_at end,
            updated_at=clock_timestamp() where id=job.id returning * into job;
    end if;
    return job;
end;
$$;
revoke all on function public.cancel_model_check(uuid) from public,anon;
grant execute on function public.cancel_model_check(uuid) to authenticated;

create function public.claim_model_check(check_engine_revision text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare job public.model_check_jobs; lease public.model_check_leases;
begin
    -- Expired executions are incomplete, never silently retried or marked green.
    update public.model_check_jobs j set status=case when cancel_requested then 'cancelled' else 'incomplete' end,
        stage='lease_expired',error_code='worker_lease_expired',finished_at=clock_timestamp(),updated_at=clock_timestamp()
        where status='running' and exists(select 1 from public.model_check_leases l where l.job_id=j.id and l.expires_at<=clock_timestamp());
    delete from public.model_check_leases l where exists(select 1 from public.model_check_jobs j where j.id=l.job_id and j.status<>'running');
    select * into job from public.model_check_jobs where status='queued'
        and engine_revision=check_engine_revision
        order by created_at,id limit 1 for update skip locked;
    if job.id is null then return null; end if;
    update public.model_check_jobs set status='running',stage='downloading',updated_at=clock_timestamp()
        where id=job.id returning * into job;
    insert into public.model_check_leases(job_id,expires_at) values(job.id,clock_timestamp()+interval '30 seconds') returning * into lease;
    return jsonb_build_object('job',to_jsonb(job),'lease_token',lease.token,'engine',
        (select to_jsonb(e) from public.model_check_engines e where e.revision=job.engine_revision));
end;
$$;
revoke all on function public.claim_model_check(text) from public,anon,authenticated;
grant execute on function public.claim_model_check(text) to service_role;

create function public.heartbeat_model_check(check_job_id uuid,check_lease_token uuid,check_stage text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare job public.model_check_jobs; valid boolean; source record;
begin
    select * into job from public.model_check_jobs where id=check_job_id for update;
    select exists(select 1 from public.model_check_leases where job_id=check_job_id and token=check_lease_token and expires_at>clock_timestamp()) into valid;
    if job.status is distinct from 'running' or not valid then return jsonb_build_object('active',false); end if;
    select * into source from public.model_check_source(job.model_id);
    if source.source_revision is distinct from job.source_revision then
        update public.model_check_jobs set cancel_requested=true,error_code='source_changed',updated_at=clock_timestamp() where id=job.id;
        job.cancel_requested=true;
    end if;
    if check_stage not in ('downloading','archive_preflight','blender_checks','geojson_supplement','saving_report') then
        raise exception 'invalid check stage' using errcode='22023';
    end if;
    update public.model_check_leases set expires_at=clock_timestamp()+interval '30 seconds' where job_id=job.id;
    update public.model_check_jobs set stage=check_stage,updated_at=clock_timestamp() where id=job.id;
    return jsonb_build_object('active',true,'cancel_requested',job.cancel_requested);
end;
$$;
revoke all on function public.heartbeat_model_check(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.heartbeat_model_check(uuid,uuid,text) to service_role;

create function public.finish_model_check(check_job_id uuid,check_lease_token uuid,check_status text,
    check_sha256 text default null,check_report jsonb default null,check_error_code text default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare job public.model_check_jobs; source record; final_status text; engine public.model_check_engines;
begin
    select * into job from public.model_check_jobs where id=check_job_id for update;
    if job.status is distinct from 'running' or not exists(select 1 from public.model_check_leases
        where job_id=check_job_id and token=check_lease_token and expires_at>clock_timestamp()) then return false; end if;
    if check_status not in ('completed','incomplete','cancelled','not_applicable') then
        raise exception 'invalid terminal status' using errcode='22023';
    end if;
    select * into source from public.model_check_source(job.model_id);
    final_status=check_status;
    if job.cancel_requested then final_status='cancelled'; end if;
    if source.source_revision is distinct from job.source_revision then final_status='incomplete';check_error_code='source_changed'; end if;
    select * into engine from public.model_check_engines where revision=job.engine_revision;
    if final_status in ('completed','not_applicable') and (
        check_sha256 is null or check_sha256 !~ '^[0-9a-f]{64}$'
        or (check_report->>'source_sha256') is distinct from check_sha256
        or (check_report->>'checker_version') is distinct from '1.6.1'
        or (check_report->'worker_provenance'->>'image_id') is distinct from engine.image_id
        or (check_report->'worker_provenance'->>'wrapper_sha256') is distinct from engine.wrapper_sha256
        or (check_report->>'ruleset_id') is distinct from 'moscow-npm-vpm-2026-08-18'
        or (check_report->>'status') is distinct from final_status
        or (check_report->'input_unchanged') is distinct from 'true'::jsonb
    ) then raise exception 'report provenance mismatch' using errcode='22023'; end if;
    update public.model_check_jobs set status=final_status,stage=final_status,
        source_sha256=case when final_status in ('completed','not_applicable') then check_sha256 end,
        report=case when final_status='completed' then check_report end,
        summary=case when final_status='completed' then check_report->'summary' end,
        error_code=left(check_error_code,100),finished_at=clock_timestamp(),updated_at=clock_timestamp()
        where id=job.id;
    delete from public.model_check_leases where job_id=job.id;
    return true;
end;
$$;
revoke all on function public.finish_model_check(uuid,uuid,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.finish_model_check(uuid,uuid,text,text,jsonb,text) to service_role;

create function public.get_model_check(check_job_id uuid,include_report boolean default false)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare job public.model_check_jobs; source record; result jsonb;
begin
    select * into job from public.model_check_jobs where id=check_job_id;
    if auth.uid() is null or job.id is null or not public.can_access_project_model(job.model_id,job.project_id) then
        raise exception 'model check is not accessible' using errcode='42501';
    end if;
    select * into source from public.model_check_source(job.model_id);
    result=(to_jsonb(job)-'report')||jsonb_build_object(
        'source_current',coalesce(source.source_revision=job.source_revision,false),
        'engine_current',exists(select 1 from public.model_check_engines e where e.revision=job.engine_revision and e.enabled));
    if include_report then result=result||jsonb_build_object('report',job.report); end if;
    return result;
end;
$$;
revoke all on function public.get_model_check(uuid,boolean) from public,anon;
grant execute on function public.get_model_check(uuid,boolean) to authenticated;
commit;
