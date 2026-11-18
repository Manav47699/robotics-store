#!/usr/bin/env bash
# Writes to the store database so Supabase never counts the project as inactive
# (free projects pause after 7 days without database activity).
# Calls public.keepalive_ping() (migration 0003), which inserts a heartbeat row into
# a hidden table and deletes the previous one. The store's data and pages are untouched.
# Exits non-zero if the database cannot be reached: that is the early warning that
# the project is paused, deleted or down.
#
#   scripts/keepalive.sh [SOURCE]   (uses SUPABASE_DB_URL if set, plus the public REST API)
source "$(dirname "$0")/lib.sh"
src="${1:-${GITHUB_WORKFLOW:+github}}"; src="${src:-manual}"
url=$(grep -oE "https://[a-z0-9]+\.supabase\.co" "$ROOT/js/config.js")
key=$(grep -oE "sb_publishable_[A-Za-z0-9_-]+" "$ROOT/js/config.js")
ok=0

# 1. Direct SQL (needs the DB password).
if [ -n "${SUPABASE_DB_URL:-}" ]; then
  if at=$(psql "$SUPABASE_DB_URL" -X -q -Atc "select public.keepalive_ping('$src-sql')" 2>/dev/null); then
    echo "✓ database write via SQL ok (heartbeat $at)"; ok=1
  else
    echo "::error::SQL write to the database failed (paused, deleted, wrong SUPABASE_DB_URL, or migration 0003 not applied)"
  fi
fi

# 2. Through the public REST API (no secrets needed).
body=$(mktemp); trap 'rm -f "$body"' EXIT
code=$(curl -sS -m 30 -o "$body" -w '%{http_code}' -X POST "$url/rest/v1/rpc/keepalive_ping" \
  -H "apikey: $key" -H "Content-Type: application/json" -d "{\"p_source\":\"$src-rest\"}" 2>/dev/null) || code=000
if [ "$code" = 200 ]; then
  echo "✓ database write via REST ok (heartbeat $(cat "$body"))"; ok=1
else
  echo "::error::REST write to $url failed (HTTP $code): $(head -c 300 "$body"). If the name does not resolve, the Supabase project is paused or deleted: restore it at https://supabase.com/dashboard"
fi

[ "$ok" = 1 ]
