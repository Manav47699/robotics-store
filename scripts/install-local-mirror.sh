#!/usr/bin/env bash
# Installs a systemd user timer that runs scripts/local-mirror.sh twice a day
# (and soon after boot if a run was missed while the computer was off).
# Remove with:  systemctl --user disable --now robostore-backup-mirror.timer
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT="$HOME/.config/systemd/user"
mkdir -p "$UNIT"
cat > "$UNIT/robostore-backup-mirror.service" <<UNITEOF
[Unit]
Description=Copy Robotics store backups to this computer
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=$ROOT/scripts/local-mirror.sh
UNITEOF
cat > "$UNIT/robostore-backup-mirror.timer" <<'UNITEOF'
[Unit]
Description=Copy Robotics store backups to this computer twice a day

[Timer]
OnCalendar=*-*-* 09,21:00
Persistent=true

[Install]
WantedBy=timers.target
UNITEOF
systemctl --user daemon-reload
systemctl --user enable --now robostore-backup-mirror.timer
systemctl --user list-timers robostore-backup-mirror.timer --no-pager
echo "Installed. First copy now:"; "$ROOT/scripts/local-mirror.sh" || true
