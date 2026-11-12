#!/bin/bash
# =================================================================
#                MADMIN Manager - Restore of the manager
# =================================================================
# Restores an archive of manager-backup.sh onto a manager installed with
# setup-manager.sh (same --host/--ip as the old one, so the instances find it
# and the endpoint certificate in the archive matches). Replaces the database,
# DATA_DIR and SECRET_KEY; the database password of this installation is kept.
#
# Usage:
#   sudo bash manager-restore.sh --in /root/manager.bak --passphrase-file /root/pass [-y]
#
# The instances reconnect by themselves (same CA, same address). A manager
# restored on a different address needs a new endpoint certificate
# (python -m manager.pki server-cert --host ...) and the instances must be
# told the new address before the old manager goes away (Sposta manager).
# =================================================================
set -euo pipefail
umask 077

IN=""; PASS_FILE=""; YES="false"
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --in) IN="$2"; shift ;;
        --passphrase-file) PASS_FILE="$2"; shift ;;
        -y) YES="true" ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
    shift
done
[[ $EUID -eq 0 ]] || { echo "Run as root" >&2; exit 1; }
[ -f "$IN" ] && [ -s "$PASS_FILE" ] || { echo "--in <archive> and --passphrase-file required" >&2; exit 1; }

INSTALL_DIR="/opt/madmin-manager"
DATA_DIR="$INSTALL_DIR/data"
SERVICE_USER="madmin-manager"
DB_NAME="madmin_manager"
DB_USER="madmin_manager"
ENV_FILE="$INSTALL_DIR/backend/.env"
[ -f "$ENV_FILE" ] || { echo "Install the manager first (setup-manager.sh)" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$PASS_FILE" -in "$IN" | tar -C "$WORK" -xzf -
B="$WORK/backup"
for f in database.dump env data.tar info.json; do
    [ -f "$B/$f" ] || { echo "Archive incomplete: $f missing" >&2; exit 1; }
done
echo "Archive: $(tr -d '\n' < "$B/info.json")"

if [ "$YES" != "true" ]; then
    read -r -p "Replace the database, the PKI and the backups of this manager? [y/N] " ans
    [[ "$ans" =~ ^[yY]$ ]] || exit 0
fi

systemctl stop madmin-manager.service

# Into a staging database first: the current one is dropped only when the
# restore succeeded
STAGE="${DB_NAME}_restore"
sudo -u postgres psql -qc "DROP DATABASE IF EXISTS $STAGE;"
sudo -u postgres psql -qc "CREATE DATABASE $STAGE OWNER $DB_USER;"
if ! sudo -u postgres pg_restore --exit-on-error --no-owner --role="$DB_USER" -d "$STAGE" < "$B/database.dump"; then
    sudo -u postgres psql -qc "DROP DATABASE IF EXISTS $STAGE;"
    systemctl start madmin-manager.service
    echo "Database restore failed: nothing changed" >&2
    exit 1
fi
sudo -u postgres psql -qc "DROP DATABASE $DB_NAME;"
sudo -u postgres psql -qc "ALTER DATABASE $STAGE RENAME TO $DB_NAME;"

# DATA_DIR: the old one is kept aside until the end
OLD_DATA="$DATA_DIR.before-restore.$(date +%s)"
mv "$DATA_DIR" "$OLD_DATA"
mkdir -p "$DATA_DIR"
tar -C "$DATA_DIR" -xf "$B/data.tar"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$DATA_DIR"
chmod 700 "$DATA_DIR"

# SECRET_KEY from the archive (it decrypts the PKI and the passphrases)
SECRET_KEY="$(sed -n 's/^SECRET_KEY=//p' "$B/env")"
[ -n "$SECRET_KEY" ] || { echo "SECRET_KEY missing in the archive" >&2; exit 1; }
sed -i "s/^SECRET_KEY=.*/SECRET_KEY=$SECRET_KEY/" "$ENV_FILE"

cd "$INSTALL_DIR/backend"
sudo -u "$SERVICE_USER" "$INSTALL_DIR/venv/bin/python" -m manager.pki trust-bundle
cd - >/dev/null
nginx -t && systemctl reload nginx
systemctl start madmin-manager.service

for _ in $(seq 1 60); do
    if curl -sf -o /dev/null http://127.0.0.1:8000/api/health; then
        rm -rf "$OLD_DATA"
        echo "Restore done. CA fingerprint: $(cd "$INSTALL_DIR/backend" && sudo -u "$SERVICE_USER" "$INSTALL_DIR/venv/bin/python" -m manager.pki fingerprint)"
        exit 0
    fi
    sleep 2
done
echo "The manager did not start after the restore (journalctl -u madmin-manager -e). Old DATA_DIR: $OLD_DATA" >&2
exit 1
