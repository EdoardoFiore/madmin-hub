#!/bin/bash
# =================================================================
#                MADMIN Manager - Backup of the manager
# =================================================================
# Everything needed to rebuild the manager on another machine:
#   database (pg_dump), DATA_DIR (PKI, instance backups), backend/.env (SECRET_KEY).
# The CA keys in DATA_DIR are encrypted with a key derived from SECRET_KEY, so
# this archive alone gives full control of every enrolled instance: it is
# encrypted with a passphrase (openssl, AES-256, PBKDF2) and must be stored
# offline, like the release signing keys.
#
# Usage:
#   sudo bash manager-backup.sh --out /root/manager-$(date +%F).bak --passphrase-file /root/pass
#        [--no-instance-backups]
# Restore: manager-restore.sh (see docs/OPERATIONS.md).
# =================================================================
set -euo pipefail
umask 077

OUT=""; PASS_FILE=""; WITH_BACKUPS="true"
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --out) OUT="$2"; shift ;;
        --passphrase-file) PASS_FILE="$2"; shift ;;
        --no-instance-backups) WITH_BACKUPS="false" ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
    shift
done
[[ $EUID -eq 0 ]] || { echo "Run as root" >&2; exit 1; }
[ -n "$OUT" ] && [ -n "$PASS_FILE" ] || { echo "--out and --passphrase-file required" >&2; exit 1; }
[ -s "$PASS_FILE" ] || { echo "Empty or missing passphrase file: $PASS_FILE" >&2; exit 1; }

INSTALL_DIR="/opt/madmin-manager"
DATA_DIR="$INSTALL_DIR/data"
DB_NAME="madmin_manager"
[ -f "$INSTALL_DIR/backend/.env" ] || { echo "No manager installed in $INSTALL_DIR" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/backup"

# The database is consistent on its own (pg_dump takes a snapshot); the files
# written while it runs (a backup arriving) may be missing from the archive.
sudo -u postgres pg_dump -Fc "$DB_NAME" > "$WORK/backup/database.dump"
cp "$INSTALL_DIR/backend/.env" "$WORK/backup/env"
EXCLUDE=()
[ "$WITH_BACKUPS" = "true" ] || EXCLUDE=(--exclude=./backups)
tar -C "$DATA_DIR" "${EXCLUDE[@]}" -cf "$WORK/backup/data.tar" .
cat > "$WORK/backup/info.json" << INFO
{"format": 1, "created_at": "$(date -u +%FT%TZ)", "host": "$(hostname -f)",
 "schema": $(sudo -u postgres psql -tAc "SELECT coalesce(max(version),0) FROM schema_version WHERE component='manager'" "$DB_NAME" 2>/dev/null || echo 0),
 "instance_backups": $WITH_BACKUPS}
INFO

tar -C "$WORK" -czf - backup \
    | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$PASS_FILE" -out "$OUT"
chmod 600 "$OUT"
echo "Backup written: $OUT ($(du -h "$OUT" | cut -f1))"
