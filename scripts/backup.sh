#!/usr/bin/env bash
# Creates a complete backup of the store database in a folder.
#
#   scripts/backup.sh [OUT_DIR]        (default: backups/<timestamp>)
#
# Output:
#   database.sql      full restore file (schema, rules, functions, policies, data)
#   stock.csv, issue_log.csv, bin.csv          human-readable views
#   components.csv, stock_entries.csv, issues.csv, staff.csv, audit_log.csv   raw tables
#   robostore.xlsx    the readable views + raw tables, one sheet each
#   manifest.json     row counts and SHA-256 checksums (used by verify-backup.sh)
#
# Needs pg_dump/psql version >= the server's major version (17). Set PG_BIN to use a
# specific client directory, e.g. PG_BIN=/usr/lib/postgresql/17/bin
source "$(dirname "$0")/lib.sh"
need SUPABASE_DB_URL
OUT="${1:-$ROOT/backups/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT"
PG_DUMP="${PG_BIN:+$PG_BIN/}pg_dump"
PSQL=("${PG_BIN:+$PG_BIN/}psql" "$SUPABASE_DB_URL" -X -q -v ON_ERROR_STOP=1)

client_major=$("$PG_DUMP" --version | grep -oE '[0-9]+' | head -1)
server_major=$("${PSQL[@]}" -Atc "show server_version_num" | cut -c1-2)
if [ "$client_major" -lt "$server_major" ]; then
  echo "✖ pg_dump $client_major is older than the server ($server_major). Install postgresql-client-$server_major." >&2; exit 1
fi

echo "→ dumping database"
"$PG_DUMP" "$SUPABASE_DB_URL" --schema=public --no-owner --quote-all-identifiers \
  --no-publications --no-subscriptions -f "$OUT/database.sql"
grep -q 'PostgreSQL database dump complete' "$OUT/database.sql" || { echo "✖ dump incomplete" >&2; exit 1; }

echo "→ exporting CSV"
csv() { "${PSQL[@]}" -c "\\copy ($2) to '$OUT/$1' with (format csv, header true, encoding 'UTF8')"; }
csv stock.csv "select name as \"Component\", date_added as \"Date added\", total_units as \"Total\", available_units as \"Available\", loaned_units as \"On loan\" from public.component_stock where binned_at is null order by lower(name)"
csv issue_log.csv "select i.issued_on as \"Issued on\", i.borrower_name as \"Borrower\", i.roll_number as \"Roll number\", c.name as \"Component\", i.units as \"Units\", case when i.returned_on is null then 'On loan' else 'Returned' end as \"Status\", i.returned_on as \"Returned on\" from public.issues i join public.components c on c.id = i.component_id where i.binned_at is null order by i.issued_on desc, i.id desc"
csv bin.csv "select 'Component' as \"Type\", name as \"Detail\", total_units as \"Units\", binned_at as \"Moved to bin\" from public.component_stock where binned_at is not null union all select 'Issue record', i.borrower_name || ' (' || i.roll_number || ') - ' || c.name || ', issued ' || i.issued_on, i.units, i.binned_at from public.issues i join public.components c on c.id = i.component_id where i.binned_at is not null order by 4 desc"
for t in components stock_entries issues staff audit_log; do csv "$t.csv" "select * from public.$t order by 1"; done

echo "→ building Excel workbook"
python3 "$ROOT/scripts/csv_to_xlsx.py" "$OUT" "$OUT/robostore.xlsx"

echo "→ writing manifest"
counts=$("${PSQL[@]}" -Atc "select json_build_object(
  'components', (select count(*) from public.components),
  'stock_entries', (select count(*) from public.stock_entries),
  'issues', (select count(*) from public.issues),
  'staff', (select count(*) from public.staff),
  'audit_log', (select count(*) from public.audit_log),
  'app_migrations', (select count(*) from public.app_migrations))")
server_version=$("${PSQL[@]}" -Atc "show server_version")
python3 - "$OUT" "$counts" "$server_version" <<'PY'
import hashlib, json, os, sys, datetime
out, counts, ver = sys.argv[1], json.loads(sys.argv[2]), sys.argv[3]
files = {}
for f in sorted(os.listdir(out)):
    if f == "manifest.json": continue
    h = hashlib.sha256(open(os.path.join(out, f), "rb").read()).hexdigest()
    files[f] = {"sha256": h, "bytes": os.path.getsize(os.path.join(out, f))}
json.dump({"created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
           "server_version": ver, "row_counts": counts, "files": files},
          open(os.path.join(out, "manifest.json"), "w"), indent=2)
PY
echo "✓ backup written to $OUT"
cat "$OUT/manifest.json" | python3 -c 'import json,sys; m=json.load(sys.stdin); print("  rows:", m["row_counts"])'
