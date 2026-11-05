#!/usr/bin/env bash
# Applies supabase/migrations/*.sql that haven't been applied yet, in order.
# Usage: scripts/migrate.sh            (uses SUPABASE_DB_URL from .env)
source "$(dirname "$0")/lib.sh"
need SUPABASE_DB_URL
PSQL=(psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -X -q)

has_table=$("${PSQL[@]}" -Atc "select to_regclass('public.app_migrations') is not null")
for f in "$ROOT"/supabase/migrations/*.sql; do
  v=$(basename "$f" .sql)
  if [ "$has_table" = "t" ] && [ "$("${PSQL[@]}" -Atc "select count(*) from public.app_migrations where version='$v'")" = "1" ]; then
    echo "✓ $v (already applied)"; continue
  fi
  [ -s "$f" ] || { echo "✖ $v is empty — refusing to apply" >&2; exit 1; }
  grep -q "insert into public.app_migrations (version) values ('$v')" "$f" \
    || { echo "✖ $v must record itself in public.app_migrations" >&2; exit 1; }
  echo "→ applying $v"
  "${PSQL[@]}" -f "$f"
  has_table=t
  [ "$("${PSQL[@]}" -Atc "select count(*) from public.app_migrations where version='$v'")" = "1" ] \
    || { echo "✖ $v ran but did not record itself — check the file" >&2; exit 1; }
  echo "✓ $v applied"
done
