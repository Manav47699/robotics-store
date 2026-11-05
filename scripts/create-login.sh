#!/usr/bin/env bash
# Creates (or resets the password of) the shared site login and grants it staff access.
# Usage: scripts/create-login.sh   (reads APP_LOGIN_USERNAME / APP_LOGIN_PASSWORD from .env)
# The site turns username "foo" into the internal address foo@robostore.invalid (never emailed).
source "$(dirname "$0")/lib.sh"
need SUPABASE_URL SUPABASE_SECRET_KEY SUPABASE_DB_URL APP_LOGIN_USERNAME APP_LOGIN_PASSWORD
DOMAIN="robostore.invalid"
email="$(echo "$APP_LOGIN_USERNAME" | tr '[:upper:]' '[:lower:]')@$DOMAIN"
auth=(-H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H "Content-Type: application/json")

body=$(python3 -c 'import json,sys; print(json.dumps({"email":sys.argv[1],"password":sys.argv[2],"email_confirm":True}))' "$email" "$APP_LOGIN_PASSWORD")
uid=$(psql "$SUPABASE_DB_URL" -X -Atc "select id from auth.users where email = '$email'")

if [ -z "$uid" ]; then
  resp=$(curl -sS -X POST "$SUPABASE_URL/auth/v1/admin/users" "${auth[@]}" -d "$body")
  uid=$(echo "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))')
  [ -n "$uid" ] || { echo "Failed to create user: $resp" >&2; exit 1; }
  echo "✓ created login '$APP_LOGIN_USERNAME'"
else
  resp=$(curl -sS -X PUT "$SUPABASE_URL/auth/v1/admin/users/$uid" "${auth[@]}" -d "$body")
  echo "$resp" | grep -q "\"id\":\"$uid\"" || { echo "Failed to update user: $resp" >&2; exit 1; }
  echo "✓ password reset for existing login '$APP_LOGIN_USERNAME'"
fi

psql "$SUPABASE_DB_URL" -X -q -v ON_ERROR_STOP=1 -c \
  "insert into public.staff (user_id, label) values ('$uid', '$APP_LOGIN_USERNAME') on conflict (user_id) do nothing"
echo "✓ '$APP_LOGIN_USERNAME' has staff access"
