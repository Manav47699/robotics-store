#!/usr/bin/env bash
# Fails if the newest backup in a backup-repo checkout is older than MAX_HOURS.
#   scripts/check-backup-fresh.sh BACKUP_REPO_DIR [MAX_HOURS=26]
set -euo pipefail
dir="$1"; max="${2:-26}"
python3 - "$dir/latest/manifest.json" "$max" <<'PY'
import json, sys, datetime
path, max_h = sys.argv[1], float(sys.argv[2])
try:
    m = json.load(open(path))
except Exception as e:
    print(f"::error::No readable latest/manifest.json in the backup repo ({e})"); sys.exit(1)
created = datetime.datetime.fromisoformat(m["created_at"])
age = (datetime.datetime.now(datetime.timezone.utc) - created).total_seconds() / 3600
print(f"newest backup: {m['created_at']} ({age:.1f} h old), rows: {m['row_counts']}")
if age > max_h:
    print(f"::error::Newest backup is {age:.0f} hours old (limit {max_h:.0f} h)"); sys.exit(1)
PY
