#!/bin/bash
# MADMIN Hub - Uninstaller. Removes service, nginx site, database and
# /opt/madmin-hub (PKI and backups included: every enrolled instance has to be
# enrolled again on a new hub). Usage: sudo bash uninstall-hub.sh [-y] [--keep-db]
set -u
KEEP_DB="false"; YES="false"
for a in "$@"; do case $a in -y) YES="true" ;; --keep-db) KEEP_DB="true" ;; esac; done
[[ $EUID -eq 0 ]] || { echo "Run as root"; exit 1; }
if [ "$YES" != "true" ]; then
    read -r -p "Remove MADMIN Hub, its CA and all backups? [y/N] " ans
    [[ "$ans" =~ ^[yY]$ ]] || exit 0
fi
systemctl disable --now madmin-hub.service 2>/dev/null || true
rm -f /etc/systemd/system/madmin-hub.service
systemctl daemon-reload
rm -f /etc/nginx/sites-enabled/madmin-hub.conf /etc/nginx/sites-available/madmin-hub.conf \
      /etc/nginx/snippets/madmin-hub-headers.conf /etc/nginx/snippets/madmin-hub-proxy.conf
nginx -t >/dev/null 2>&1 && systemctl reload nginx
if [ "$KEEP_DB" != "true" ] && command -v psql >/dev/null; then
    sudo -u postgres psql -c "DROP DATABASE IF EXISTS madmin_hub;" >/dev/null 2>&1
    sudo -u postgres psql -c "DROP ROLE IF EXISTS madmin_hub;" >/dev/null 2>&1
fi
rm -rf /opt/madmin-hub
userdel madmin-hub 2>/dev/null || true
echo "MADMIN Hub removed."
