-- =====================================================================
-- 0003_keepalive
-- Free Supabase projects pause after 7 days without database activity.
-- keepalive_ping() makes a real write: it inserts a heartbeat row and deletes
-- the older ones, so the table always holds exactly one row (the last ping).
--
-- Invisible to the store: the table isn't read by the site, isn't in the
-- realtime publication, has no audit trigger, and has RLS on with no policies.
-- The only way in is the function, which anyone with the public key can call
-- (that's how the Vercel cron and the REST keep-alive work without secrets).
-- Calling it repeatedly can only ever rewrite that single row.
-- =====================================================================
begin;

create table public.keepalive_heartbeat (
  id        bigint generated always as identity primary key,
  pinged_at timestamptz not null default now(),
  source    text not null check (length(source) between 1 and 40)
);
alter table public.keepalive_heartbeat enable row level security;
revoke all on public.keepalive_heartbeat from public, anon, authenticated;

create or replace function public.keepalive_ping(p_source text default 'unknown')
returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  v_id bigint;
  v_at timestamptz;
begin
  insert into public.keepalive_heartbeat (source)
  values (left(coalesce(nullif(trim(p_source), ''), 'unknown'), 40))
  returning id, pinged_at into v_id, v_at;
  delete from public.keepalive_heartbeat where id <> v_id;
  return v_at;
end $$;

revoke execute on function public.keepalive_ping(text) from public;
grant execute on function public.keepalive_ping(text) to anon, authenticated, service_role;

insert into public.app_migrations (version) values ('0003_keepalive');
commit;
