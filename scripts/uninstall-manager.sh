#!/bin/bash
# MADMIN Manager - Uninstaller. Removes service, nginx site, database and
# /opt/madmin-manager (PKI and backups included: every enrolled instance has to be
# enrolled again on a new manager). Usage: sudo bash uninstall-manager.sh [-y] [--keep-db]
set -u
KEEP_DB="false"; YES="false"
for a in "$@"; do case $a in -y) YES="true" ;; --keep-db) KEEP_DB="true" ;; esac; done
[[ $EUID -eq 0 ]] || { echo "Run as root"; exit 1; }
if [ "$YES" != "true" ]; then
    read -r -p "Remove MADMIN Manager, its CA and all backups? [y/N] " ans
    [[ "$ans" =~ ^[yY]$ ]] || exit 0
fi
systemctl disable --now madmin-manager.service 2>/dev/null || true
rm -f /etc/systemd/system/madmin-manager.service
systemctl daemon-reload
rm -f /etc/nginx/sites-enabled/madmin-manager.conf /etc/nginx/sites-available/madmin-manager.conf \
      /etc/nginx/snippets/madmin-manager-headers.conf /etc/nginx/snippets/madmin-manager-proxy.conf
nginx -t >/dev/null 2>&1 && systemctl reload nginx
if [ "$KEEP_DB" != "true" ] && command -v psql >/dev/null; then
    sudo -u postgres psql -c "DROP DATABASE IF EXISTS madmin_manager;" >/dev/null 2>&1
    sudo -u postgres psql -c "DROP ROLE IF EXISTS madmin_manager;" >/dev/null 2>&1
fi
rm -rf /opt/madmin-manager
userdel madmin-manager 2>/dev/null || true
echo "MADMIN Manager removed."
