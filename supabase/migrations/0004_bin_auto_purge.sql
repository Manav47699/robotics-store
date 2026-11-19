-- =====================================================================
-- 0004_bin_auto_purge
-- Anything that has been in the Bin for more than 60 days is deleted
-- permanently, exactly as if someone had clicked "Delete permanently".
--
--   * Deletions still go through the audit trigger, so every purged row is
--     kept in audit_log (old_row) and in the backups taken before the purge.
--   * Runs from keepalive_ping(), which is called several times a day by
--     GitHub Actions and Vercel Cron. That keeps it in the public schema, so
--     it survives a restore from backup (a pg_cron job would not).
--   * Purely time-based: calling it more often can't delete anything sooner.
--     A failure never breaks the keep-alive.
-- =====================================================================
begin;

create function public.purge_bin() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_cutoff  constant timestamptz := now() - interval '60 days';
  v_deleted integer := 0;
  r record;
begin
  -- Loan records first, then components (deleting a component cascades to
  -- its stock entries and loan records). One row at a time, so a row that a
  -- rule refuses to delete is skipped instead of blocking the rest.
  for r in select id from public.issues where binned_at < v_cutoff loop
    begin
      delete from public.issues where id = r.id;
      v_deleted := v_deleted + 1;
    exception when others then
      raise warning 'purge_bin: kept issue %: %', r.id, sqlerrm;
    end;
  end loop;

  for r in select id from public.components where binned_at < v_cutoff loop
    begin
      delete from public.components where id = r.id;
      v_deleted := v_deleted + 1;
    exception when others then
      raise warning 'purge_bin: kept component %: %', r.id, sqlerrm;
    end;
  end loop;

  return v_deleted;
end $$;

revoke execute on function public.purge_bin() from public, anon, authenticated;
grant execute on function public.purge_bin() to service_role;

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

  begin
    perform public.purge_bin();
  exception when others then
    raise warning 'keepalive_ping: purge_bin failed: %', sqlerrm;
  end;

  return v_at;
end $$;

insert into public.app_migrations (version) values ('0004_bin_auto_purge');
commit;
