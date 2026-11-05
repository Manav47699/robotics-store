# Shared helpers for scripts/*. Loads .env without echoing secrets.
# Variables already set in the environment take priority over .env.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$ROOT/.env" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"; val="${BASH_REMATCH[2]}"
    [ -n "${!key:-}" ] || export "$key=$val"
  done < "$ROOT/.env"
fi
need() { for v in "$@"; do [ -n "${!v:-}" ] || { echo "Missing $v (set it in .env or the environment)" >&2; exit 1; }; done; }
