#!/bin/sh
# Nightly backup: SQLite DB (consistent online backup) + uploaded media, 14-day retention.
set -e
APP=/var/www/kn
OUT=/var/backups/kn
mkdir -p "$OUT"
cd "$APP"
node backup.js
# uploaded media
tar -czf "$OUT/uploads-$(date +%F).tgz" -C "$APP" uploads 2>/dev/null || true
# retention
find "$OUT" -name 'uploads-*.tgz' -mtime +14 -delete 2>/dev/null || true
find "$OUT" -name 'kn-*.db' -mtime +14 -delete 2>/dev/null || true
echo "$(date -Is) backup complete"
