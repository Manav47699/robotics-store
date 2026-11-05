-- =====================================================================
-- 0002_fix_stock_lock
-- assert_stock() used SELECT ... FOR UPDATE on the component row. Inserting
-- an issue already holds a FOR KEY SHARE lock on that row (foreign key check),
-- so two simultaneous issues each held KEY SHARE and waited for the other's
-- FOR UPDATE -> deadlock. FOR NO KEY UPDATE does not conflict with KEY SHARE
-- but does conflict with itself, so concurrent writes are still serialised.
-- issue_component() and add_stock() now take that lock before inserting.
-- =====================================================================
begin;

create or replace function public.assert_stock(p_component_id bigint) returns void
language plpgsql set search_path = '' as $$
declare
  v_name   text;
  v_total  bigint;
  v_out    bigint;
begin
  select c.name into v_name from public.components c where c.id = p_component_id for no key update;
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

create or replace function public.issue_component(
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

  -- Serialise writes for this component before touching the issues table.
  perform 1 from public.components where id = p_component_id for no key update;
  if not found then raise exception 'That component no longer exists.' using errcode = 'P0001'; end if;

  if p_request_id is not null then
    select id into v_id from public.issues where client_request_id = p_request_id;
    if found then return v_id; end if;
  end if;

  insert into public.issues (component_id, units, borrower_name, roll_number, issued_on, client_request_id)
  values (p_component_id, p_units, v_name, v_roll, p_issued_on, p_request_id)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.add_stock(p_name text, p_units integer, p_added_on date, p_request_id uuid default null)
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
     for no key update;
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

  update public.components set date_added = p_added_on where id = v_id and date_added > p_added_on;
  return v_id;
end $$;

-- Safety net: a stuck request can never hold locks for long.
alter role authenticated set lock_timeout = '8s';
alter role authenticated set statement_timeout = '15s';

insert into public.app_migrations (version) values ('0002_fix_stock_lock');
commit;
