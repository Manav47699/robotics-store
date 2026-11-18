#!/usr/bin/env bash
# Keeps a full copy of the private backup repo (every backup ever made) on this
# computer: a third copy that does not depend on GitHub. Shows a desktop alert if
# the copy can't be updated or the newest backup is more than 2 days old.
#
#   scripts/local-mirror.sh             (run twice a day by scripts/install-local-mirror.sh)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${ROBOSTORE_MIRROR:-$HOME/robotics-store-backups}"
REPO=git@github.com:Manav47699/robotics-store-backup.git
export GIT_SSH_COMMAND="ssh -i $ROOT/secrets/backup_deploy_key -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
alert() {
  echo "✖ $1" >&2
  command -v notify-send >/dev/null && notify-send -u critical "Robotics store backups" "$1" || true
}
if [ -d "$DEST/.git" ]; then
  git -C "$DEST" pull -q --ff-only || { alert "Could not update the local backup copy in $DEST"; exit 1; }
else
  git clone -q "$REPO" "$DEST" || { alert "Could not download the backups (is the deploy key added to robotics-store-backup?)"; exit 1; }
fi
"$ROOT/scripts/check-backup-fresh.sh" "$DEST" 48 \
  || { alert "Newest backup is more than 2 days old. Check GitHub → Actions → Nightly backup."; exit 1; }
echo "✓ local copy up to date: $DEST"
