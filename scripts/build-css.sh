#!/usr/bin/env bash
# Rebuilds assets/app.css from assets/input.css. Run after changing classes in index.html or js/.
# Usage: scripts/build-css.sh          (CI runs `scripts/build-css.sh --check`)
set -euo pipefail
cd "$(dirname "$0")/.."
TW="tailwindcss@3.4.19"
if [ "${1:-}" = "--check" ]; then
  tmp=$(mktemp)
  npx --yes "$TW" -c tailwind.config.js -i assets/input.css -o "$tmp" --minify >/dev/null 2>&1
  if ! cmp -s "$tmp" assets/app.css; then
    echo "✖ assets/app.css is out of date. Run scripts/build-css.sh and commit the result."; rm -f "$tmp"; exit 1
  fi
  rm -f "$tmp"; echo "✓ assets/app.css is up to date"; exit 0
fi
npx --yes "$TW" -c tailwind.config.js -i assets/input.css -o assets/app.css --minify
echo "✓ built assets/app.css ($(wc -c < assets/app.css) bytes)"
