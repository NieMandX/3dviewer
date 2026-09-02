-- Test database only. Minimal Supabase Auth/Storage contracts, never production.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema storage;
create schema extensions;
create extension if not exists pgcrypto with schema extensions;
create table auth.users (id uuid primary key, email text);
create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;
create function auth.uid() returns uuid language sql stable as $$
    select nullif(auth.jwt()->>'sub', '')::uuid;
$$;
create table storage.buckets (id text primary key, name text, public boolean);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner_id text);
alter table storage.objects enable row level security;
grant usage on schema auth, public, storage to anon, authenticated, service_role;
grant all on storage.objects to authenticated, service_role;
alter default privileges in schema public grant all on tables to authenticated, service_role;
