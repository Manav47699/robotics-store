#!/usr/bin/env bash
# Proves a backup can actually be restored.
#
#   scripts/verify-backup.sh BACKUP_DIR EMPTY_DATABASE_URL
#
# Restores BACKUP_DIR/database.sql into an EMPTY scratch Postgres (never production),
# then checks file checksums, row counts against manifest.json, and stock rules.
set -euo pipefail
DIR="$1"; TARGET="$2"
PSQL=("${PG_BIN:+$PG_BIN/}psql" "$TARGET" -X -q -v ON_ERROR_STOP=1)

case "$TARGET" in *supabase.co*|*supabase.com*) echo "✖ refusing to restore into a Supabase database" >&2; exit 1 ;; esac

echo "→ checking checksums"
python3 - "$DIR" <<'PY'
import hashlib, json, os, sys
d = sys.argv[1]
m = json.load(open(os.path.join(d, "manifest.json")))
for f, meta in m["files"].items():
    h = hashlib.sha256(open(os.path.join(d, f), "rb").read()).hexdigest()
    if h != meta["sha256"]:
        sys.exit(f"✖ checksum mismatch: {f}")
print(f"  {len(m['files'])} files OK")
PY

echo "→ preparing scratch database (Supabase roles + auth.uid stub)"
"${PSQL[@]}" <<'SQL'
do $$ begin
  if exists (select 1 from information_schema.tables where table_schema = 'public') then
    raise exception 'target database is not empty';
  end if;
end $$;
do $$ declare r text; begin
  foreach r in array array['anon','authenticated','service_role','supabase_admin','postgres'] loop
    if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if;
  end loop;
end $$;
drop schema if exists public cascade;   -- empty default schema; database.sql recreates it
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
SQL

echo "→ restoring database.sql"
"${PSQL[@]}" -f "$DIR/database.sql" >/dev/null

echo "→ comparing row counts"
actual=$("${PSQL[@]}" -Atc "select json_build_object(
  'components', (select count(*) from public.components),
  'stock_entries', (select count(*) from public.stock_entries),
  'issues', (select count(*) from public.issues),
  'staff', (select count(*) from public.staff),
  'audit_log', (select count(*) from public.audit_log),
  'app_migrations', (select count(*) from public.app_migrations))")
python3 - "$DIR" "$actual" <<'PY'
import json, os, sys
expected = json.load(open(os.path.join(sys.argv[1], "manifest.json")))["row_counts"]
actual = json.loads(sys.argv[2])
bad = {k: (expected[k], actual.get(k)) for k in expected if expected[k] != actual.get(k)}
if bad:
    sys.exit(f"✖ row counts differ (expected, restored): {bad}")
print("  ", actual)
PY

echo "→ checking stock rules survived the restore"
neg=$("${PSQL[@]}" -Atc "select count(*) from public.component_stock where available_units < 0")
[ "$neg" = "0" ] || { echo "✖ $neg component(s) with negative stock" >&2; exit 1; }
"${PSQL[@]}" -Atc "select count(*) from pg_trigger where tgname in ('issues_check','stock_entries_check','components_guard','issues_audit') " | grep -qx 4 \
  || { echo "✖ protection triggers missing after restore" >&2; exit 1; }
"${PSQL[@]}" -Atc "select bool_and(relrowsecurity) from pg_class where oid in ('public.components'::regclass,'public.issues'::regclass,'public.stock_entries'::regclass)" | grep -qx t \
  || { echo "✖ row-level security not enabled after restore" >&2; exit 1; }
cid=$("${PSQL[@]}" -Atc "select id from public.components where binned_at is null limit 1")
if [ -n "$cid" ]; then
  if "${PSQL[@]}" -c "begin; insert into public.issues (component_id, units, borrower_name, roll_number, issued_on) values ($cid, 100000, 'probe', 'probe', current_date); rollback;" >/dev/null 2>&1; then
    echo "✖ restored database allowed over-issuing stock" >&2; exit 1
  fi
  echo "  over-issue correctly refused by restored database"
fi
echo "✓ backup verified: restorable, complete, rules intact"
