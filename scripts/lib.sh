# Shared helpers for scripts/*. Loads .env without echoing secrets.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$ROOT/.env" ]; then
  set -a; # shellcheck disable=SC1091
  . "$ROOT/.env"; set +a
fi
need() { for v in "$@"; do [ -n "${!v:-}" ] || { echo "Missing $v (set it in .env or the environment)" >&2; exit 1; }; done; }
