-- =====================================================================
-- RoboStore — 0001_init
-- Inventory + issue ledger for the Robotics Club store.
--
-- Design rules
--   * Stock totals are DERIVED from stock_entries (never typed in directly).
--   * Available = total - units on active (unreturned, not-binned) loans.
--   * The database itself refuses any change that would make available < 0,
--     using a row lock so two people issuing at the same moment can't both win.
--   * Every insert/update/delete on every table is copied to audit_log,
--     so even "permanently deleted" rows can be recovered by an admin.
--   * Only logged-in staff (rows in public.staff) can read or write anything.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table public.staff (
  user_id    uuid primary key,              -- = auth.users.id (no FK: keeps backups portable)
  label      text not null,
  created_at timestamptz not null default now()
);

create table public.components (
  id          bigint generated always as identity primary key,
  name        text        not null check (name = btrim(name) and char_length(name) between 1 and 120),
  date_added  date        not null,
  binned_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- Names are unique (case-insensitive) among components that are not in the bin.
create unique index components_name_active_uniq
  on public.components (lower(name)) where binned_at is null;

create table public.stock_entries (
  id                bigint generated always as identity primary key,
  component_id      bigint      not null references public.components(id) on delete cascade,
  units             integer     not null check (units > 0 and units <= 100000),
  added_on          date        not null,
  client_request_id uuid        unique,     -- idempotency: a retried request can't add stock twice
  created_at        timestamptz not null default now()
);
create index stock_entries_component_idx on public.stock_entries (component_id);

create table public.issues (
  id                bigint generated always as identity primary key,
  component_id      bigint      not null references public.components(id) on delete cascade,
  units             integer     not null check (units > 0 and units <= 100000),
  borrower_name     text        not null check (borrower_name = btrim(borrower_name) and char_length(borrower_name) between 1 and 120),
  roll_number       text        not null check (roll_number = btrim(roll_number) and char_length(roll_number) between 1 and 30),
  issued_on         date        not null,
  returned_on       date,
  binned_at         timestamptz,
  client_request_id uuid        unique,     -- idempotency: a retried request can't issue twice
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint issues_return_after_issue check (returned_on is null or returned_on >= issued_on)
);
create index issues_component_idx on public.issues (component_id);
create index issues_active_idx on public.issues (component_id) where returned_on is null and binned_at is null;

create table public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      uuid,
  table_name text        not null,
  op         text        not null,
  row_id     text,
  old_row    jsonb,
  new_row    jsonb
);
create index audit_log_at_idx on public.audit_log (at);

create table public.app_migrations (
  version    text primary key,
  applied_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- "Today" in Nepal, regardless of server timezone.
create function public.today_npt() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'Asia/Kathmandu')::date
$$;

create function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff s where s.user_id = auth.uid())
$$;

create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger components_touch before update on public.components
  for each row execute function public.touch_updated_at();
create trigger issues_touch before update on public.issues
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- Audit trail (append-only; only the database owner / backups can read it)
-- ---------------------------------------------------------------------

create function public.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_log (actor, table_name, op, row_id, old_row, new_row)
  values (
    auth.uid(),
    tg_table_name,
    tg_op,
    coalesce((case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) ->> 'id',
             (case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) ->> 'user_id'),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return null;
end $$;

create trigger components_audit    after insert or update or delete on public.components    for each row execute function public.audit_row();
create trigger stock_entries_audit after insert or update or delete on public.stock_entries for each row execute function public.audit_row();
create trigger issues_audit        after insert or update or delete on public.issues        for each row execute function public.audit_row();
create trigger staff_audit         after insert or update or delete on public.staff         for each row execute function public.audit_row();

create function public.audit_log_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_log is append-only';
end $$;
create trigger audit_log_no_update before update or delete on public.audit_log
  for each row execute function public.audit_log_immutable();

-- ---------------------------------------------------------------------
-- Stock invariant: units out on loan can never exceed total units.
-- Runs inside the same transaction as the change and locks the component
-- row, so concurrent issues are serialised.
-- ---------------------------------------------------------------------

create function public.assert_stock(p_component_id bigint) returns void
language plpgsql set search_path = '' as $$
declare
  v_name   text;
  v_total  bigint;
  v_out    bigint;
begin
  select c.name into v_name from public.components c where c.id = p_component_id for update;
  if not found then
    return;  -- component is being deleted (cascade)
  end if;

  select coalesce(sum(units), 0) into v_total from public.stock_entries where component_id = p_component_id;
  select coalesce(sum(units), 0) into v_out   from public.issues
   where component_id = p_component_id and returned_on is null and binned_at is null;

  if v_out > v_total then
    raise exception 'Not enough stock of "%": % in total, % would be out on loan.', v_name, v_total, v_out
      using errcode = 'P0001', hint = 'stock';
  end if;
end $$;

create function public.issues_check() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_binned timestamptz;
begin
  if tg_op = 'INSERT' or new.component_id is distinct from old.component_id
     or (new.binned_at is null and old.binned_at is not null)
     or (new.returned_on is null and old.returned_on is not null) then
    select binned_at into v_binned from public.components where id = new.component_id;
    if v_binned is not null and new.binned_at is null and new.returned_on is null then
      raise exception 'That component is in the bin. Restore it first.' using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'INSERT' and new.issued_on > public.today_npt() + 1 then
    raise exception 'Issue date can''t be in the future.' using errcode = 'P0001';
  end if;
  if new.returned_on is not null and (tg_op = 'INSERT' or old.returned_on is null)
     and new.returned_on > public.today_npt() + 1 then
    raise exception 'Return date can''t be in the future.' using errcode = 'P0001';
  end if;

  perform public.assert_stock(new.component_id);
  if tg_op = 'UPDATE' and old.component_id is distinct from new.component_id then
    perform public.assert_stock(old.component_id);
  end if;
  return null;
end $$;
create trigger issues_check after insert or update on public.issues
  for each row execute function public.issues_check();

create function public.stock_entries_check() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' and new.added_on > public.today_npt() + 1 then
    raise exception 'Date added can''t be in the future.' using errcode = 'P0001';
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.assert_stock(old.component_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.assert_stock(new.component_id);
  end if;
  return null;
end $$;
create trigger stock_entries_check after insert or update or delete on public.stock_entries
  for each row execute function public.stock_entries_check();

-- A component with units still out on loan can't be binned or deleted.
create function public.components_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_out bigint;
begin
  if tg_op = 'DELETE' or (new.binned_at is not null and old.binned_at is null) then
    select coalesce(sum(units), 0) into v_out from public.issues
     where component_id = old.id and returned_on is null and binned_at is null;
    if v_out > 0 then
      raise exception '"%" still has % unit(s) out on loan. Mark them returned (or bin those loans) first.', old.name, v_out
        using errcode = 'P0001';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger components_guard before update or delete on public.components
  for each row execute function public.components_guard();

-- ---------------------------------------------------------------------
-- Read model
-- ---------------------------------------------------------------------

create view public.component_stock with (security_invoker = true) as
select
  c.id,
  c.name,
  c.date_added,
  c.binned_at,
  c.created_at,
  coalesce(s.total, 0)::integer                       as total_units,
  coalesce(l.loaned, 0)::integer                      as loaned_units,
  (coalesce(s.total, 0) - coalesce(l.loaned, 0))::integer as available_units
from public.components c
left join (select component_id, sum(units) total from public.stock_entries group by component_id) s
  on s.component_id = c.id
left join (select component_id, sum(units) loaned from public.issues
            where returned_on is null and binned_at is null group by component_id) l
  on l.component_id = c.id;

-- ---------------------------------------------------------------------
-- API functions — the ONLY write path. SECURITY DEFINER, each one checks
-- is_staff() first; table triggers still enforce every stock rule.
-- ---------------------------------------------------------------------

create function public.add_stock(p_name text, p_units integer, p_added_on date, p_request_id uuid default null)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_id   bigint;
begin
  if not public.is_staff() then raise exception 'Not authorised.' using errcode = '42501'; end if;
  if v_name = '' then raise exception 'Component name is required.' using errcode = 'P0001'; end if;
  if p_units is null or p_units < 1 then raise exception 'Units must be at least 1.' using errcode = 'P0001'; end if;
  if p_added_on is null then raise exception 'Date added is required.' using errcode = 'P0001'; end if;

  if p_request_id is not null then
    select component_id into v_id from public.stock_entries where client_request_id = p_request_id;
    if found then return v_id; end if;  -- duplicate submit / network retry
  end if;

  if exists (select 1 from public.components where lower(name) = lower(v_name) and binned_at is not null)
     and not exists (select 1 from public.components where lower(name) = lower(v_name) and binned_at is null) then
    raise exception '"%" is in the bin. Restore it from the Bin page instead of adding it again.', v_name
      using errcode = 'P0001';
  end if;

  loop
    select id into v_id from public.components
     where lower(name) = lower(v_name) and binned_at is null
     for update;
    exit when found;
    begin
      insert into public.components (name, date_added) values (v_name, p_added_on) returning id into v_id;
      exit;
    exception when unique_violation then
      -- someone else created it at the same instant; loop and use theirs
    end;
  end loop;

  insert into public.stock_entries (component_id, units, added_on, client_request_id)
  values (v_id, p_units, p_added_on, p_request_id);

  update public.components set date_added = least(date_added, p_added_on) where id = v_id and date_added > p_added_on;
  return v_id;
end $$;

create function public.issue_component(
  p_component_id bigint, p_units integer, p_borrower_name text, p_roll_number text,
  p_issued_on date, p_request_id uuid default null)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_id   bigint;
  v_name text := regexp_replace(btrim(coalesce(p_borrower_name, '')), '\s+', ' ', 'g');
  v_roll text := upper(regexp_replace(coalesce(p_roll_number, ''), '\s+', '', 'g'));
begin
  if not public.is_staff() then raise exception 'Not authorised.' using errcode = '42501'; end if;
  if p_component_id is null then raise exception 'Choose a component.' using errcode = 'P0001'; end if;
  if p_units is null or p_units < 1 then raise exception 'Units must be at least 1.' using errcode = 'P0001'; end if;
  if v_name = '' then raise exception 'Borrower''s full name is required.' using errcode = 'P0001'; end if;
  if v_roll = '' then raise exception 'Roll number is required.' using errcode = 'P0001'; end if;
  if p_issued_on is null then raise exception 'Issue date is required.' using errcode = 'P0001'; end if;

  if p_request_id is not null then
    select id into v_id from public.issues where client_request_id = p_request_id;
    if found then return v_id; end if;
  end if;

  insert into public.issues (component_id, units, borrower_name, roll_number, issued_on, client_request_id)
  values (p_component_id, p_units, v_name, v_roll, p_issued_on, p_request_id)
  returning id into v_id;
  return v_id;
end $$;

create function public.return_issue(p_issue_id bigint, p_returned_on date)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_issue public.issues%rowtype;
begin
  if not public.is_staff() then raise exception 'Not authorised.' using errcode = '42501'; end if;
  if p_returned_on is null then raise exception 'Return date is required.' using errcode = 'P0001'; end if;
  select * into v_issue from public.issues where id = p_issue_id for update;
  if not found then raise exception 'That record no longer exists.' using errcode = 'P0001'; end if;
  if v_issue.returned_on is not null then return; end if;  -- already returned (double click / other user)
  if p_returned_on < v_issue.issued_on then
    raise exception 'Return date can''t be before the issue date (%).', to_char(v_issue.issued_on, 'DD Mon YYYY')
      using errcode = 'P0001';
  end if;
  update public.issues set returned_on = p_returned_on where id = p_issue_id;
end $$;

-- p_kind: 'component' | 'issue'
create function public.move_to_bin(p_kind text, p_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'Not authorised.' using errcode = '42501'; end if;
  if p_kind = 'component' then
    update public.components set binned_at = now() where id = p_id and binned_at is null;
  elsif p_kind = 'issue' then
    update public.issues set binned_at = now() where id = p_id and binned_at is null;
  else
    raise exception 'Unknown kind %', p_kind;
  end if;
end $$;

create function public.restore_from_bin(p_kind text, p_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
begin
  if not public.is_staff() then raise exception 'Not authorised.' using errcode = '42501'; end if;
  if p_kind = 'component' then
    select name into v_name from public.components where id = p_id;
    if exists (select 1 from public.components where lower(name) = lower(v_name) and binned_at is null and id <> p_id) then
      raise exception 'A component named "%" already exists in stock. Rename or delete one of them first.', v_name
        using errcode = 'P0001';
    end if;
    update public.components set binned_at = null where id = p_id;
  elsif p_kind = 'issue' then
    update public.issues set binned_at = null where id = p_id;
  else
    raise exception 'Unknown kind %', p_kind;
  end if;
end $$;

create function public.delete_permanently(p_kind text, p_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'Not authorised.' using errcode = '42501'; end if;
  if p_kind = 'component' then
    delete from public.components where id = p_id;   -- cascades to its stock entries and issue records
  elsif p_kind = 'issue' then
    delete from public.issues where id = p_id;
  else
    raise exception 'Unknown kind %', p_kind;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Row-level security & privileges
-- ---------------------------------------------------------------------

alter table public.staff          enable row level security;
alter table public.components     enable row level security;
alter table public.stock_entries  enable row level security;
alter table public.issues         enable row level security;
alter table public.audit_log      enable row level security;
alter table public.app_migrations enable row level security;

create policy staff_read_self on public.staff for select to authenticated using (user_id = auth.uid());

create policy components_staff    on public.components    for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy stock_entries_staff on public.stock_entries for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy issues_staff        on public.issues        for all to authenticated using (public.is_staff()) with check (public.is_staff());
-- audit_log and app_migrations: no policies => no access for anon/authenticated.

-- Logged-out visitors get nothing at all.
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from public, anon;

-- Logged-in users: read the data, write only through the API functions above.
revoke all on all tables in schema public from authenticated;
grant select on public.components, public.stock_entries, public.issues, public.component_stock, public.staff to authenticated;
grant execute on function
  public.is_staff(), public.today_npt(),
  public.add_stock(text, integer, date, uuid),
  public.issue_component(bigint, integer, text, text, date, uuid),
  public.return_issue(bigint, date),
  public.move_to_bin(text, bigint),
  public.restore_from_bin(text, bigint),
  public.delete_permanently(text, bigint)
to authenticated;

-- Internal trigger helpers must not be callable directly.
revoke execute on function public.assert_stock(bigint), public.audit_row(), public.issues_check(),
  public.stock_entries_check(), public.components_guard(), public.touch_updated_at(),
  public.audit_log_immutable() from authenticated;

-- ---------------------------------------------------------------------
-- Realtime: push changes to every open browser
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.components, public.stock_entries, public.issues;
  end if;
end $$;

insert into public.app_migrations (version) values ('0001_init');

commit;
