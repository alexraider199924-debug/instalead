#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/instalead}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/instalead}"
mkdir -p "$BACKUP_DIR"
tar -czf "$BACKUP_DIR/instalead-$(date +%F-%H%M%S).tar.gz" -C "$APP_DIR/backend" data
find "$BACKUP_DIR" -type f -name '*.tar.gz' -mtime +14 -delete
echo "Backup written to $BACKUP_DIR"
