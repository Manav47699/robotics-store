#!/usr/bin/env bash
# Restores a backup into a database — use for disaster recovery or moving to a new project.
#
#   scripts/restore.sh BACKUP_DIR TARGET_DATABASE_URL
#
# TARGET should be a NEW, EMPTY Supabase project (or any Postgres 17+). Everything in its
# public schema is replaced. After restoring into a new Supabase project:
#   1. scripts/create-login.sh   (with the new project's values in .env) to recreate the login
#   2. update js/config.js with the new project URL + publishable key, commit, push
#   3. re-run the realtime line printed at the end of this script
set -euo pipefail
DIR="$1"; TARGET="$2"
PSQL=("${PG_BIN:+$PG_BIN/}psql" "$TARGET" -X -q -v ON_ERROR_STOP=1)
[ -f "$DIR/database.sql" ] || { echo "✖ $DIR/database.sql not found" >&2; exit 1; }

echo "This REPLACES everything in the public schema of:"
echo "  $(echo "$TARGET" | sed -E 's#://([^:]+):[^@]+@#://\1:****@#')"
echo "with the backup from $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["created_at"])' "$DIR/manifest.json")."
read -r -p "Type RESTORE to continue: " answer
[ "$answer" = "RESTORE" ] || { echo "Cancelled."; exit 1; }

has_data=$("${PSQL[@]}" -Atc "select to_regclass('public.components') is not null")
if [ "$has_data" = "t" ]; then
  echo "→ saving a safety backup of the target first"
  SUPABASE_DB_URL="$TARGET" "$(dirname "$0")/backup.sh" "$(dirname "$0")/../backups/pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
fi

echo "→ restoring"
"${PSQL[@]}" -c "drop schema if exists public cascade"
"${PSQL[@]}" -f "$DIR/database.sql" >/dev/null
"${PSQL[@]}" -c "grant usage on schema public to anon, authenticated, service_role" 2>/dev/null || true
"${PSQL[@]}" -c "do \$\$ begin if exists (select 1 from pg_publication where pubname='supabase_realtime') then
  alter publication supabase_realtime add table public.components, public.stock_entries, public.issues; end if; end \$\$" 2>/dev/null \
  || echo "  (realtime publication already set or unavailable)"
echo "✓ restored. Row counts:"
"${PSQL[@]}" -Atc "select 'components', count(*) from public.components union all select 'issues', count(*) from public.issues union all select 'stock_entries', count(*) from public.stock_entries"
echo
echo "If this is a NEW Supabase project, the login account does not exist there yet."
echo "Run scripts/create-login.sh with the new project's values in .env."
