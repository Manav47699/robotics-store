#!/usr/bin/env bash
# CI helper: clones the private backup repo using the BACKUP_DEPLOY_KEY secret.
#   scripts/clone-backup-repo.sh DIR [DEPTH]
set -euo pipefail
: "${BACKUP_DEPLOY_KEY:?BACKUP_DEPLOY_KEY is not set}"
: "${BACKUP_REPO:=git@github.com:Manav47699/robotics-store-backup.git}"
dir="$1"; depth="${2:-50}"
mkdir -p ~/.ssh && chmod 700 ~/.ssh
printf '%s\n' "$BACKUP_DEPLOY_KEY" > ~/.ssh/backup_key && chmod 600 ~/.ssh/backup_key
ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null
export GIT_SSH_COMMAND="ssh -i ~/.ssh/backup_key -o IdentitiesOnly=yes"
for i in 1 2 3; do git clone -q --depth "$depth" "$BACKUP_REPO" "$dir" && exit 0; sleep 20; done
echo "::error::Could not clone the backup repo. Is BACKUP_DEPLOY_KEY's public half a write deploy key on robotics-store-backup?"
exit 1
