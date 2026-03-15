


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."add_project_owner_member"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
    insert into public.project_members (project_id, user_id, role)
    values (new.id, new.owner_id, 'owner')
    on conflict do nothing;
    return new;
end;
$$;


ALTER FUNCTION "public"."add_project_owner_member"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_camera"("room_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
    if auth.uid() is null then
        raise exception 'not authenticated';
    end if;
    update public.rooms
    set camera_owner_id = auth.uid()
    where id = room_id
      and exists (
          select 1
          from public.project_members pm
          where pm.project_id = rooms.project_id
            and pm.user_id = auth.uid()
      );
end;
$$;


ALTER FUNCTION "public"."claim_camera"("room_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_project_model_storage_object"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'storage'
    AS $$
declare
    raw_path text;
    bucket text;
    object_name text;
    meta_storage_path text;
begin
    meta_storage_path := coalesce(old.meta ->> 'storagePath', old.meta ->> 'storage_path', '');
    if meta_storage_path <> '' then
        bucket := 'models';
        object_name := ltrim(meta_storage_path, '/');
    elsif old.url is null or old.url = '' then
        return old;
    elsif position('storage://' in old.url) = 1 then
        raw_path := substr(old.url, length('storage://') + 1);
        bucket := split_part(raw_path, '/', 1);
        object_name := substr(raw_path, length(bucket) + 2);
    elsif position('/storage/v1/object/' in old.url) > 0 then
        raw_path := split_part(old.url, '/storage/v1/object/', 2);
        raw_path := split_part(raw_path, '?', 1);
        if raw_path = '' then
            return old;
        end if;
        raw_path := regexp_replace(raw_path, '^(public|sign|authenticated)/', '');
        bucket := split_part(raw_path, '/', 1);
        object_name := substr(raw_path, length(bucket) + 2);
    else
        return old;
    end if;

    if bucket = '' or object_name = '' then
        return old;
    end if;

    begin
        delete from storage.objects
        where bucket_id = bucket
          and name = object_name;
    exception
        when insufficient_privilege then
            null;
    end;

    return old;
end;
$$;


ALTER FUNCTION "public"."delete_project_model_storage_object"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_registered_user"() RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
    select coalesce(auth.jwt() ->> 'email', '') <> '';
$$;


ALTER FUNCTION "public"."is_registered_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_superuser"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select exists (
        select 1
        from public.user_roles
        where user_id = auth.uid()
          and role = 'superuser'
    );
$$;


ALTER FUNCTION "public"."is_superuser"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."projects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slug" "text" NOT NULL,
    "name" "text" NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "meta" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."projects" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."join_project_by_slug"("project_slug" "text", "room_slug" "text") RETURNS "public"."projects"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    proj public.projects;
begin
    if auth.uid() is null then
        raise exception 'not authenticated';
    end if;
    if coalesce(trim(room_slug), '') = '' then
        raise exception 'room slug required';
    end if;
    select p.*
    into proj
    from public.projects p
    where p.slug = project_slug
      and exists (
          select 1
          from public.rooms r
          where r.project_id = p.id
            and r.slug = room_slug
      )
    limit 1;
    if proj.id is null then
        raise exception 'project room link not found';
    end if;
    insert into public.project_members (project_id, user_id, role)
    values (proj.id, auth.uid(), 'member')
    on conflict do nothing;
    return proj;
end;
$$;


ALTER FUNCTION "public"."join_project_by_slug"("project_slug" "text", "room_slug" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ensure_room_invite"("room_id" "uuid") RETURNS TABLE("token" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    room_row public.rooms;
    invite_row public.room_invites;
begin
    if auth.uid() is null then
        raise exception 'not authenticated';
    end if;

    select r.*
    into room_row
    from public.rooms r
    where r.id = room_id
      and exists (
          select 1
          from public.project_members pm
          where pm.project_id = r.project_id
            and pm.user_id = auth.uid()
      )
    limit 1;

    if room_row.id is null then
        raise exception 'room not found';
    end if;

    select ri.*
    into invite_row
    from public.room_invites ri
    where ri.room_id = room_row.id
    limit 1;

    if invite_row.room_id is null then
        insert into public.room_invites (room_id, project_id, token, created_by)
        values (room_row.id, room_row.project_id, encode(gen_random_bytes(24), 'hex'), auth.uid())
        returning * into invite_row;
    end if;

    return query
    select invite_row.token;
end;
$$;


ALTER FUNCTION "public"."ensure_room_invite"("room_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."join_room_by_invite"("invite_token" "text") RETURNS "public"."rooms"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    room_row public.rooms;
begin
    if auth.uid() is null then
        raise exception 'not authenticated';
    end if;
    if coalesce(trim(invite_token), '') = '' then
        raise exception 'invite token required';
    end if;

    select r.*
    into room_row
    from public.room_invites ri
    join public.rooms r
      on r.id = ri.room_id
     and r.project_id = ri.project_id
    where ri.token = trim(invite_token)
    limit 1;

    if room_row.id is null then
        raise exception 'room invite not found';
    end if;

    insert into public.project_members (project_id, user_id, role)
    values (room_row.project_id, auth.uid(), 'member')
    on conflict do nothing;

    return room_row;
end;
$$;


ALTER FUNCTION "public"."join_room_by_invite"("invite_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_camera"("room_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
    if auth.uid() is null then
        raise exception 'not authenticated';
    end if;
    update public.rooms
    set camera_owner_id = null
    where id = room_id
      and exists (
          select 1
          from public.project_members pm
          where pm.project_id = rooms.project_id
            and pm.user_id = auth.uid()
      )
      and (camera_owner_id = auth.uid() or owner_id = auth.uid());
end;
$$;


ALTER FUNCTION "public"."release_camera"("room_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
    new.updated_at = now();
    return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."annotations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "room_id" "uuid" NOT NULL,
    "author_id" "uuid" NOT NULL,
    "author_name" "text" NOT NULL,
    "kind" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."annotations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "room_id" "uuid" NOT NULL,
    "author_id" "uuid" NOT NULL,
    "author_name" "text" NOT NULL,
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "display_name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."project_members" (
    "project_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "text" DEFAULT 'member'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."project_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."project_models" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "url" "text" NOT NULL,
    "meta" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."project_models" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."room_cameras" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "room_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "position" "jsonb" NOT NULL,
    "target" "jsonb" NOT NULL,
    "up" "jsonb",
    "fov" double precision,
    "zoom" double precision,
    "near" double precision,
    "far" double precision,
    "shift_x" double precision,
    "shift_y" double precision,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."room_cameras" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."room_models" (
    "room_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "model_id" "uuid" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "visible" boolean DEFAULT true NOT NULL,
    "transform" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."room_models" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."room_transitions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "room_id" "uuid" NOT NULL,
    "from_camera_id" "uuid" NOT NULL,
    "to_camera_id" "uuid" NOT NULL,
    "seconds" double precision DEFAULT 0 NOT NULL,
    "type" "text" DEFAULT 'ease-in-out'::"text" NOT NULL,
    "trajectory" "text" DEFAULT 'linear'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."room_transitions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rooms" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "slug" "text" NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "active_model_id" "uuid",
    "camera_state" "jsonb",
    "camera_owner_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."rooms" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."room_invites" (
    "room_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "token" "text" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."room_invites" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_roles" (
    "user_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_roles" OWNER TO "postgres";


ALTER TABLE ONLY "public"."annotations"
    ADD CONSTRAINT "annotations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_pkey" PRIMARY KEY ("project_id", "user_id");



ALTER TABLE ONLY "public"."project_models"
    ADD CONSTRAINT "project_models_id_project_id_key" UNIQUE ("id", "project_id");



ALTER TABLE ONLY "public"."project_models"
    ADD CONSTRAINT "project_models_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."room_cameras"
    ADD CONSTRAINT "room_cameras_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."room_models"
    ADD CONSTRAINT "room_models_pkey" PRIMARY KEY ("room_id", "model_id");



ALTER TABLE ONLY "public"."room_transitions"
    ADD CONSTRAINT "room_transitions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rooms"
    ADD CONSTRAINT "rooms_id_project_id_key" UNIQUE ("id", "project_id");



ALTER TABLE ONLY "public"."rooms"
    ADD CONSTRAINT "rooms_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rooms"
    ADD CONSTRAINT "rooms_project_id_slug_key" UNIQUE ("project_id", "slug");


ALTER TABLE ONLY "public"."room_invites"
    ADD CONSTRAINT "room_invites_pkey" PRIMARY KEY ("room_id");


ALTER TABLE ONLY "public"."room_invites"
    ADD CONSTRAINT "room_invites_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id", "role");



CREATE INDEX "annotations_room_created_idx" ON "public"."annotations" USING "btree" ("room_id", "created_at");



CREATE INDEX "messages_room_created_idx" ON "public"."messages" USING "btree" ("room_id", "created_at");



CREATE INDEX "project_models_project_idx" ON "public"."project_models" USING "btree" ("project_id", "created_at");



CREATE INDEX "room_models_room_idx" ON "public"."room_models" USING "btree" ("room_id", "sort_order");


CREATE INDEX "room_invites_project_idx" ON "public"."room_invites" USING "btree" ("project_id", "created_at");



CREATE INDEX "rooms_project_idx" ON "public"."rooms" USING "btree" ("project_id", "created_at");



CREATE OR REPLACE TRIGGER "project_models_storage_delete" AFTER DELETE ON "public"."project_models" FOR EACH ROW EXECUTE FUNCTION "public"."delete_project_model_storage_object"();



CREATE OR REPLACE TRIGGER "project_models_updated_at" BEFORE UPDATE ON "public"."project_models" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "projects_owner_member" AFTER INSERT ON "public"."projects" FOR EACH ROW EXECUTE FUNCTION "public"."add_project_owner_member"();



CREATE OR REPLACE TRIGGER "projects_updated_at" BEFORE UPDATE ON "public"."projects" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "room_cameras_updated_at" BEFORE UPDATE ON "public"."room_cameras" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "room_invites_updated_at" BEFORE UPDATE ON "public"."room_invites" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "rooms_updated_at" BEFORE UPDATE ON "public"."rooms" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



ALTER TABLE ONLY "public"."annotations"
    ADD CONSTRAINT "annotations_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."annotations"
    ADD CONSTRAINT "annotations_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_models"
    ADD CONSTRAINT "project_models_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."room_cameras"
    ADD CONSTRAINT "room_cameras_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."room_models"
    ADD CONSTRAINT "room_models_model_id_project_id_fkey" FOREIGN KEY ("model_id", "project_id") REFERENCES "public"."project_models"("id", "project_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."room_models"
    ADD CONSTRAINT "room_models_room_id_project_id_fkey" FOREIGN KEY ("room_id", "project_id") REFERENCES "public"."rooms"("id", "project_id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."room_invites"
    ADD CONSTRAINT "room_invites_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."room_invites"
    ADD CONSTRAINT "room_invites_room_id_project_id_fkey" FOREIGN KEY ("room_id", "project_id") REFERENCES "public"."rooms"("id", "project_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."room_transitions"
    ADD CONSTRAINT "room_transitions_from_camera_id_fkey" FOREIGN KEY ("from_camera_id") REFERENCES "public"."room_cameras"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."room_transitions"
    ADD CONSTRAINT "room_transitions_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."room_transitions"
    ADD CONSTRAINT "room_transitions_to_camera_id_fkey" FOREIGN KEY ("to_camera_id") REFERENCES "public"."room_cameras"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."rooms"
    ADD CONSTRAINT "rooms_active_model_id_project_id_fkey" FOREIGN KEY ("active_model_id", "project_id") REFERENCES "public"."project_models"("id", "project_id");



ALTER TABLE ONLY "public"."rooms"
    ADD CONSTRAINT "rooms_camera_owner_id_fkey" FOREIGN KEY ("camera_owner_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."rooms"
    ADD CONSTRAINT "rooms_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."rooms"
    ADD CONSTRAINT "rooms_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE "public"."annotations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "annotations_delete" ON "public"."annotations" FOR DELETE TO "authenticated" USING ((("author_id" = "auth"."uid"()) OR "public"."is_superuser"()));



CREATE POLICY "annotations_insert" ON "public"."annotations" FOR INSERT TO "authenticated" WITH CHECK ((("author_id" = "auth"."uid"()) AND ((EXISTS ( SELECT 1
   FROM ("public"."rooms" "r"
     JOIN "public"."project_members" "pm" ON (("pm"."project_id" = "r"."project_id")))
  WHERE (("r"."id" = "annotations"."room_id") AND ("pm"."user_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM ("public"."rooms" "r"
     JOIN "public"."projects" "p" ON (("p"."id" = "r"."project_id")))
  WHERE (("r"."id" = "annotations"."room_id") AND ("p"."owner_id" = "auth"."uid"())))))));



CREATE POLICY "annotations_select" ON "public"."annotations" FOR SELECT TO "authenticated" USING (("public"."is_superuser"() OR (EXISTS ( SELECT 1
   FROM ("public"."rooms" "r"
     JOIN "public"."project_members" "pm" ON (("pm"."project_id" = "r"."project_id")))
  WHERE (("r"."id" = "annotations"."room_id") AND ("pm"."user_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM ("public"."rooms" "r"
     JOIN "public"."projects" "p" ON (("p"."id" = "r"."project_id")))
  WHERE (("r"."id" = "annotations"."room_id") AND ("p"."owner_id" = "auth"."uid"()))))));



ALTER TABLE "public"."messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "messages_delete" ON "public"."messages" FOR DELETE TO "authenticated" USING ((("author_id" = "auth"."uid"()) OR "public"."is_superuser"()));



CREATE POLICY "messages_insert" ON "public"."messages" FOR INSERT TO "authenticated" WITH CHECK ((("author_id" = "auth"."uid"()) AND ((EXISTS ( SELECT 1
   FROM ("public"."rooms" "r"
     JOIN "public"."project_members" "pm" ON (("pm"."project_id" = "r"."project_id")))
  WHERE (("r"."id" = "messages"."room_id") AND ("pm"."user_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM ("public"."rooms" "r"
     JOIN "public"."projects" "p" ON (("p"."id" = "r"."project_id")))
  WHERE (("r"."id" = "messages"."room_id") AND ("p"."owner_id" = "auth"."uid"())))))));



CREATE POLICY "messages_select" ON "public"."messages" FOR SELECT TO "authenticated" USING (("public"."is_superuser"() OR (EXISTS ( SELECT 1
   FROM ("public"."rooms" "r"
     JOIN "public"."project_members" "pm" ON (("pm"."project_id" = "r"."project_id")))
  WHERE (("r"."id" = "messages"."room_id") AND ("pm"."user_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM ("public"."rooms" "r"
     JOIN "public"."projects" "p" ON (("p"."id" = "r"."project_id")))
  WHERE (("r"."id" = "messages"."room_id") AND ("p"."owner_id" = "auth"."uid"()))))));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_insert" ON "public"."profiles" FOR INSERT TO "authenticated" WITH CHECK (("id" = "auth"."uid"()));



CREATE POLICY "profiles_select" ON "public"."profiles" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "profiles_update" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("id" = "auth"."uid"())) WITH CHECK (("id" = "auth"."uid"()));



ALTER TABLE "public"."project_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "project_members_delete" ON "public"."project_members" FOR DELETE TO "authenticated" USING ((("user_id" = "auth"."uid"()) OR "public"."is_superuser"() OR (EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE (("p"."id" = "project_members"."project_id") AND ("p"."owner_id" = "auth"."uid"()))))));



CREATE POLICY "project_members_insert" ON "public"."project_members" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE (("p"."id" = "project_members"."project_id") AND ("p"."owner_id" = "auth"."uid"())))));



CREATE POLICY "project_members_select" ON "public"."project_members" FOR SELECT TO "authenticated" USING ((("user_id" = "auth"."uid"()) OR "public"."is_superuser"()));



ALTER TABLE "public"."project_models" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "project_models_delete" ON "public"."project_models" FOR DELETE TO "authenticated" USING (("public"."is_superuser"() OR (EXISTS ( SELECT 1
   FROM "public"."project_members" "pm"
  WHERE (("pm"."project_id" = "project_models"."project_id") AND ("pm"."user_id" = "auth"."uid"()))))));



CREATE POLICY "project_models_insert" ON "public"."project_models" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."project_members" "pm"
  WHERE (("pm"."project_id" = "project_models"."project_id") AND ("pm"."user_id" = "auth"."uid"())))));



CREATE POLICY "project_models_select" ON "public"."project_models" FOR SELECT TO "authenticated" USING (("public"."is_superuser"() OR (EXISTS ( SELECT 1
   FROM "public"."project_members" "pm"
  WHERE (("pm"."project_id" = "project_models"."project_id") AND ("pm"."user_id" = "auth"."uid"()))))));



CREATE POLICY "project_models_update" ON "public"."project_models" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."project_members" "pm"
  WHERE (("pm"."project_id" = "project_models"."project_id") AND ("pm"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."project_members" "pm"
  WHERE (("pm"."project_id" = "project_models"."project_id") AND ("pm"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."projects" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "projects_delete" ON "public"."projects" FOR DELETE TO "authenticated" USING ((("owner_id" = "auth"."uid"()) OR "public"."is_superuser"()));



CREATE POLICY "projects_insert" ON "public"."projects" FOR INSERT TO "authenticated" WITH CHECK ((("owner_id" = "auth"."uid"()) AND "public"."is_registered_user"()));



CREATE POLICY "projects_select" ON "public"."projects" FOR SELECT TO "authenticated" USING ((("owner_id" = "auth"."uid"()) OR "public"."is_superuser"() OR (EXISTS ( SELECT 1
   FROM "public"."project_members" "pm"
  WHERE (("pm"."project_id" = "projects"."id") AND ("pm"."user_id" = "auth"."uid"()))))));



CREATE POLICY "projects_update" ON "public"."projects" FOR UPDATE TO "authenticated" USING (("owner_id" = "auth"."uid"())) WITH CHECK (("owner_id" = "auth"."uid"()));



ALTER TABLE "public"."room_cameras" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "room_cameras_delete" ON "public"."room_cameras" FOR DELETE TO "authenticated" USING (("public"."is_superuser"() OR (EXISTS ( SELECT 1
   FROM ("public"."rooms" "r"
     JOIN "public"."project_members" "pm" ON (("pm"."project_id" = "r"."project_id")))
  WHERE (("r"."id" = "room_cameras"."room_id") AND ("pm"."user_id" = "auth"."uid"()))))));



CREATE POLICY "room_cameras_insert" ON "public"."room_cameras" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."rooms" "r"
     JOIN "public"."project_members" "pm" ON (("pm"."project_id" = "r"."project_id")))
  WHERE (("r"."id" = "room_cameras"."room_id") AND ("pm"."user_id" = "auth"."uid"())))));



CREATE POLICY "room_cameras_select" ON "public"."room_cameras" FOR SELECT TO "authenticated" USING (("public"."is_superuser"() OR (EXISTS ( SELECT 1
   FROM ("public"."rooms" "r"
     JOIN "public"."project_members" "pm" ON (("pm"."project_id" = "r"."project_id")))
  WHERE (("r"."id" = "room_cameras"."room_id") AND ("pm"."user_id" = "auth"."uid"()))))));



CREATE POLICY "room_cameras_update" ON "public"."room_cameras" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM ("public"."rooms" "r"
     JOIN "public"."project_members" "pm" ON (("pm"."project_id" = "r"."project_id")))
  WHERE (("r"."id" = "room_cameras"."room_id") AND ("pm"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."rooms" "r"
     JOIN "public"."project_members" "pm" ON (("pm"."project_id" = "r"."project_id")))
  WHERE (("r"."id" = "room_cameras"."room_id") AND ("pm"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."room_invites" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."room_models" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "room_models_delete" ON "public"."room_models" FOR DELETE TO "authenticated" USING (("public"."is_superuser"() OR (EXISTS ( SELECT 1
   FROM "public"."project_members" "pm"
  WHERE (("pm"."project_id" = "room_models"."project_id") AND ("pm"."user_id" = "auth"."uid"()))))));



CREATE POLICY "room_models_insert" ON "public"."room_models" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."project_members" "pm"
  WHERE (("pm"."project_id" = "room_models"."project_id") AND ("pm"."user_id" = "auth"."uid"())))));



CREATE POLICY "room_models_select" ON "public"."room_models" FOR SELECT TO "authenticated" USING (("public"."is_superuser"() OR (EXISTS ( SELECT 1
   FROM "public"."project_members" "pm"
  WHERE (("pm"."project_id" = "room_models"."project_id") AND ("pm"."user_id" = "auth"."uid"()))))));



CREATE POLICY "room_models_update" ON "public"."room_models" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."project_members" "pm"
  WHERE (("pm"."project_id" = "room_models"."project_id") AND ("pm"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."project_members" "pm"
  WHERE (("pm"."project_id" = "room_models"."project_id") AND ("pm"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."room_transitions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "room_transitions_delete" ON "public"."room_transitions" FOR DELETE TO "authenticated" USING (("public"."is_superuser"() OR (EXISTS ( SELECT 1
   FROM ("public"."rooms" "r"
     JOIN "public"."project_members" "pm" ON (("pm"."project_id" = "r"."project_id")))
  WHERE (("r"."id" = "room_transitions"."room_id") AND ("pm"."user_id" = "auth"."uid"()))))));



CREATE POLICY "room_transitions_insert" ON "public"."room_transitions" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."rooms" "r"
     JOIN "public"."project_members" "pm" ON (("pm"."project_id" = "r"."project_id")))
  WHERE (("r"."id" = "room_transitions"."room_id") AND ("pm"."user_id" = "auth"."uid"())))));



CREATE POLICY "room_transitions_select" ON "public"."room_transitions" FOR SELECT TO "authenticated" USING (("public"."is_superuser"() OR (EXISTS ( SELECT 1
   FROM ("public"."rooms" "r"
     JOIN "public"."project_members" "pm" ON (("pm"."project_id" = "r"."project_id")))
  WHERE (("r"."id" = "room_transitions"."room_id") AND ("pm"."user_id" = "auth"."uid"()))))));



CREATE POLICY "room_transitions_update" ON "public"."room_transitions" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM ("public"."rooms" "r"
     JOIN "public"."project_members" "pm" ON (("pm"."project_id" = "r"."project_id")))
  WHERE (("r"."id" = "room_transitions"."room_id") AND ("pm"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."rooms" "r"
     JOIN "public"."project_members" "pm" ON (("pm"."project_id" = "r"."project_id")))
  WHERE (("r"."id" = "room_transitions"."room_id") AND ("pm"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."rooms" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "rooms_delete" ON "public"."rooms" FOR DELETE TO "authenticated" USING ((("owner_id" = "auth"."uid"()) OR "public"."is_superuser"() OR (EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE (("p"."id" = "rooms"."project_id") AND ("p"."owner_id" = "auth"."uid"()))))));



CREATE POLICY "rooms_insert" ON "public"."rooms" FOR INSERT TO "authenticated" WITH CHECK ((("owner_id" = "auth"."uid"()) AND "public"."is_registered_user"() AND (EXISTS ( SELECT 1
   FROM "public"."project_members" "pm"
  WHERE (("pm"."project_id" = "rooms"."project_id") AND ("pm"."user_id" = "auth"."uid"()))))));



CREATE POLICY "rooms_select" ON "public"."rooms" FOR SELECT TO "authenticated" USING (("public"."is_superuser"() OR (EXISTS ( SELECT 1
   FROM "public"."project_members" "pm"
  WHERE (("pm"."project_id" = "rooms"."project_id") AND ("pm"."user_id" = "auth"."uid"()))))));



CREATE POLICY "rooms_update" ON "public"."rooms" FOR UPDATE TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."project_members" "pm"
  WHERE (("pm"."project_id" = "rooms"."project_id") AND ("pm"."user_id" = "auth"."uid"())))) AND (("owner_id" = "auth"."uid"()) OR ("camera_owner_id" IS NULL) OR ("camera_owner_id" = "auth"."uid"())))) WITH CHECK (((EXISTS ( SELECT 1
   FROM "public"."project_members" "pm"
  WHERE (("pm"."project_id" = "rooms"."project_id") AND ("pm"."user_id" = "auth"."uid"())))) AND (("camera_owner_id" IS NULL) OR ("camera_owner_id" = "auth"."uid"()))));



ALTER TABLE "public"."user_roles" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";






GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";

























































































































































GRANT ALL ON FUNCTION "public"."add_project_owner_member"() TO "anon";
GRANT ALL ON FUNCTION "public"."add_project_owner_member"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."add_project_owner_member"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_camera"("room_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_camera"("room_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."claim_camera"("room_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_camera"("room_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."delete_project_model_storage_object"() TO "anon";
GRANT ALL ON FUNCTION "public"."delete_project_model_storage_object"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_project_model_storage_object"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_registered_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_registered_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_registered_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_superuser"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_superuser"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_superuser"() TO "service_role";



GRANT ALL ON TABLE "public"."projects" TO "anon";
GRANT ALL ON TABLE "public"."projects" TO "authenticated";
GRANT ALL ON TABLE "public"."projects" TO "service_role";



REVOKE ALL ON FUNCTION "public"."join_project_by_slug"("project_slug" "text", "room_slug" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."join_project_by_slug"("project_slug" "text", "room_slug" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."join_project_by_slug"("project_slug" "text", "room_slug" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."ensure_room_invite"("room_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."ensure_room_invite"("room_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ensure_room_invite"("room_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."join_room_by_invite"("invite_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."join_room_by_invite"("invite_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."join_room_by_invite"("invite_token" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."release_camera"("room_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."release_camera"("room_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."release_camera"("room_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."release_camera"("room_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";


















GRANT ALL ON TABLE "public"."annotations" TO "anon";
GRANT ALL ON TABLE "public"."annotations" TO "authenticated";
GRANT ALL ON TABLE "public"."annotations" TO "service_role";



GRANT ALL ON TABLE "public"."messages" TO "anon";
GRANT ALL ON TABLE "public"."messages" TO "authenticated";
GRANT ALL ON TABLE "public"."messages" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."project_members" TO "anon";
GRANT ALL ON TABLE "public"."project_members" TO "authenticated";
GRANT ALL ON TABLE "public"."project_members" TO "service_role";



GRANT ALL ON TABLE "public"."project_models" TO "anon";
GRANT ALL ON TABLE "public"."project_models" TO "authenticated";
GRANT ALL ON TABLE "public"."project_models" TO "service_role";



GRANT ALL ON TABLE "public"."room_cameras" TO "anon";
GRANT ALL ON TABLE "public"."room_cameras" TO "authenticated";
GRANT ALL ON TABLE "public"."room_cameras" TO "service_role";


GRANT ALL ON TABLE "public"."room_invites" TO "anon";
GRANT ALL ON TABLE "public"."room_invites" TO "authenticated";
GRANT ALL ON TABLE "public"."room_invites" TO "service_role";



GRANT ALL ON TABLE "public"."room_models" TO "anon";
GRANT ALL ON TABLE "public"."room_models" TO "authenticated";
GRANT ALL ON TABLE "public"."room_models" TO "service_role";



GRANT ALL ON TABLE "public"."room_transitions" TO "anon";
GRANT ALL ON TABLE "public"."room_transitions" TO "authenticated";
GRANT ALL ON TABLE "public"."room_transitions" TO "service_role";



GRANT ALL ON TABLE "public"."rooms" TO "anon";
GRANT ALL ON TABLE "public"."rooms" TO "authenticated";
GRANT ALL ON TABLE "public"."rooms" TO "service_role";



GRANT ALL ON TABLE "public"."user_roles" TO "anon";
GRANT ALL ON TABLE "public"."user_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_roles" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































drop extension if exists "pg_net";


  create policy "models_read"
  on "storage"."objects"
  as permissive
  for select
  to authenticated
using ((bucket_id = 'models'::text));



  create policy "models_upload"
  on "storage"."objects"
  as permissive
  for insert
  to authenticated
with check ((bucket_id = 'models'::text));



  create policy "models_delete"
  on "storage"."objects"
  as permissive
  for delete
  to authenticated
using (((bucket_id = 'models'::text) AND ("public"."is_superuser"() OR (COALESCE((owner_id)::text, ''::text) = (auth.uid())::text) OR ((COALESCE(array_length(storage.foldername(name), 1), 0) >= 2) AND ((storage.foldername(name))[1] = 'projects'::text) AND (EXISTS ( SELECT 1
   FROM public.project_members pm
  WHERE ((pm.user_id = auth.uid()) AND ((pm.project_id)::text = (storage.foldername(name))[2]))))))));
