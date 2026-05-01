#!/usr/bin/env bash
# MADMIN Hub — bare-metal Ubuntu 24.04 installer
# Usage: sudo bash setup-hub.sh [-u admin_username] [-p admin_password]

set -euo pipefail

HUB_DIR="/opt/madmin-hub"
HUB_USER="madmin_hub"
HUB_PORT=7444  # dedicated port — no collision with managed MADMIN (7443)
DB_NAME="madmin_hub"
DB_USER="madmin_hub"

ADMIN_USERNAME=""
ADMIN_PASSWORD=""

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[HUB]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
die()  { echo -e "${RED}[ERR]${NC} $*"; exit 1; }

while getopts "u:p:" opt; do
    case $opt in
        u) ADMIN_USERNAME="$OPTARG" ;;
        p) ADMIN_PASSWORD="$OPTARG" ;;
        *) die "Usage: $0 [-u username] [-p password]" ;;
    esac
done

[[ $EUID -ne 0 ]] && die "Run as root"

# --- Deps ---
log "Installing system dependencies…"
apt-get update -qq
apt-get install -y --no-install-recommends \
    python3.12 python3.12-venv python3.12-dev \
    postgresql postgresql-client \
    nginx \
    openssl \
    git \
    libpq-dev gcc

# --- DB ---
log "Setting up PostgreSQL…"
DB_PASS=$(openssl rand -hex 24)
sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';" 2>/dev/null || true
sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};" 2>/dev/null || true

# --- System user ---
id -u "$HUB_USER" &>/dev/null || useradd -r -m -d "$HUB_DIR" -s /bin/bash "$HUB_USER"

# --- Deploy ---
log "Deploying MADMIN Hub…"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$HUB_DIR"
cp -r "$SCRIPT_DIR/backend" "$HUB_DIR/"
cp -r "$SCRIPT_DIR/frontend" "$HUB_DIR/"

# Python venv
python3.12 -m venv "$HUB_DIR/venv"
"$HUB_DIR/venv/bin/pip" install --quiet --upgrade pip
"$HUB_DIR/venv/bin/pip" install --quiet -r "$HUB_DIR/backend/requirements.txt"

# .env
SECRET_KEY=$(openssl rand -hex 32)
PUBLIC_URL="https://$(hostname -f)"
cat > "$HUB_DIR/backend/.env" <<EOF
DATABASE_URL=postgresql+asyncpg://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}
SECRET_KEY=${SECRET_KEY}
DEBUG=false
ALLOWED_ORIGINS=*
HUB_PUBLIC_URL=${PUBLIC_URL}:${HUB_PORT}
TELEMETRY_RETENTION_DAYS=30
EOF
chmod 600 "$HUB_DIR/backend/.env"
chown -R "$HUB_USER:$HUB_USER" "$HUB_DIR"

# --- Systemd ---
log "Configuring systemd service…"
cat > /etc/systemd/system/madmin-hub.service <<EOF
[Unit]
Description=MADMIN Hub
After=network.target postgresql.service

[Service]
Type=simple
User=${HUB_USER}
WorkingDirectory=${HUB_DIR}/backend
ExecStart=${HUB_DIR}/venv/bin/uvicorn main:app --host 127.0.0.1 --port 8080 --workers 1
Restart=always
RestartSec=5
EnvironmentFile=${HUB_DIR}/backend/.env
StandardOutput=journal
StandardError=journal
SyslogIdentifier=madmin-hub

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now madmin-hub

# --- First admin user ---
if [[ -n "$ADMIN_USERNAME" && -n "$ADMIN_PASSWORD" ]]; then
    log "Creating first admin user '${ADMIN_USERNAME}'…"
    # wait for backend to be ready (max 30s)
    for i in $(seq 1 30); do
        curl -sf http://127.0.0.1:8080/api/health > /dev/null 2>&1 && break
        sleep 1
    done
    INIT_RESP=$(curl -sf -X POST http://127.0.0.1:8080/api/auth/init \
        -H "Content-Type: application/json" \
        -d "{\"username\":\"${ADMIN_USERNAME}\",\"password\":\"${ADMIN_PASSWORD}\"}" 2>&1) \
        && log "Admin user '${ADMIN_USERNAME}' created." \
        || warn "Could not create admin user automatically: ${INIT_RESP}"
fi

# --- TLS cert (self-signed) ---
log "Generating self-signed TLS certificate…"
CERT_DIR="/etc/ssl/madmin-hub"
mkdir -p "$CERT_DIR"
openssl req -x509 -nodes -days 3650 -newkey rsa:4096 \
    -keyout "$CERT_DIR/hub.key" \
    -out    "$CERT_DIR/hub.crt" \
    -subj "/CN=$(hostname -f)" \
    -addext "subjectAltName=DNS:$(hostname -f),IP:$(hostname -I | awk '{print $1}')" 2>/dev/null

# --- Nginx ---
log "Configuring Nginx…"
cat > /etc/nginx/sites-available/madmin-hub <<EOF
server {
    listen ${HUB_PORT} ssl http2;
    server_name _;

    ssl_certificate     ${CERT_DIR}/hub.crt;
    ssl_certificate_key ${CERT_DIR}/hub.key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    location /api/agents/ws {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host \$host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / {
        proxy_pass       http://127.0.0.1:8080;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
EOF
ln -sf /etc/nginx/sites-available/madmin-hub /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# --- Done ---
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║        MADMIN Hub installato OK          ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  URL Hub:   ${GREEN}https://$(hostname -I | awk '{print $1}'):${HUB_PORT}${NC}"
if [[ -n "$ADMIN_USERNAME" ]]; then
    echo -e "  Admin:     ${GREEN}${ADMIN_USERNAME}${NC} (password specificata)"
else
    echo -e "  Primo accesso: vai all'URL sopra → setup del primo utente admin"
    echo -e "  Oppure:    sudo bash setup-hub.sh -u admin -p 'Password1!'"
fi
echo -e "  Logs:      journalctl -u madmin-hub -f"
echo ""
warn "Salva queste credenziali DB in luogo sicuro:"
echo -e "  DB user:   ${DB_USER}"
echo -e "  DB pass:   ${DB_PASS}"
echo -e "  .env path: ${HUB_DIR}/backend/.env"
