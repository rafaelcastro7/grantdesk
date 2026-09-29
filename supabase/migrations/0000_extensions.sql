-- Extensions the schema needs, created by the migrations themselves.
--
-- Locally supabase/init/01-roles-and-auth.sql creates them before any
-- migration runs; a hosted Supabase project (Lovable Cloud) has no init
-- script, so 0001's vector columns failed on a fresh database. Hosted
-- Supabase keeps extensions in the "extensions" schema; a plain Postgres
-- does not have it. Idempotent either way.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'extensions') then
    create extension if not exists vector with schema extensions;
    create extension if not exists pgcrypto with schema extensions;
    create extension if not exists "uuid-ossp" with schema extensions;
  else
    create extension if not exists vector;
    create extension if not exists pgcrypto;
    create extension if not exists "uuid-ossp";
  end if;
end $$;
