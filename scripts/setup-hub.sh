#!/bin/bash
# =================================================================
#                     MADMIN Hub - Installer
# =================================================================
# Ubuntu 24.04. Installs the hub in /opt/madmin-hub:
#   - PostgreSQL database, venv, systemd unit (user madmin-hub, not root)
#   - PKI: agent CA, agent endpoint certificate, SSH CA, license key
#   - nginx: UI on --ui-port (443), agent endpoint with client
#     certificates on --agent-port (8443)
#   - the first administrator
#
# Usage:
#   sudo MADMIN_HUB_ADMIN_PASSWORD='...' bash setup-hub.sh --host hub.example.com [--ip 10.0.0.5]
#        [-u admin] [--ui-port 443] [--agent-port 8443]
#
# --host / --ip: the name and/or address instances use to reach the hub.
# They go into the agent endpoint certificate and into every enrollment token.
# Ports to open towards the hub: UI (operators), agent (instances), the
# support range 9100-9119 (operators; configurable in Settings).
# =================================================================
set -euo pipefail

log_info() { echo -e "\033[34m[INFO]\033[0m $1"; }
log_success() { echo -e "\033[32m[SUCCESS]\033[0m $1"; }
log_error() { echo -e "\033[31m[ERROR]\033[0m $1" >&2; }
log_warning() { echo -e "\033[33m[WARNING]\033[0m $1"; }

ADMIN_USERNAME="admin"
ADMIN_PASSWORD="${MADMIN_HUB_ADMIN_PASSWORD:-}"
HUB_HOSTS=()
HUB_IPS=()
UI_PORT=443
AGENT_PORT=8443

while [[ "$#" -gt 0 ]]; do
    case $1 in
        -u|--username) ADMIN_USERNAME="$2"; shift ;;
        -p|--password) ADMIN_PASSWORD="$2"; shift ;;
        --host) HUB_HOSTS+=("$2"); shift ;;
        --ip) HUB_IPS+=("$2"); shift ;;
        --ui-port) UI_PORT="$2"; shift ;;
        --agent-port) AGENT_PORT="$2"; shift ;;
        *) log_error "Unknown option: $1"; exit 1 ;;
    esac
    shift
done

if [[ $EUID -ne 0 ]]; then
    log_error "Run as root: sudo bash setup-hub.sh ..."
    exit 1
fi
if [ ${#HUB_HOSTS[@]} -eq 0 ] && [ ${#HUB_IPS[@]} -eq 0 ]; then
    log_error "--host and/or --ip required (how instances reach the hub)"
    exit 1
fi
if [ -z "$ADMIN_PASSWORD" ]; then
    log_error "Administrator password required: MADMIN_HUB_ADMIN_PASSWORD=... (or -p)"
    exit 1
fi
# Same rules as the backend (validate_password_strength)
if [ ${#ADMIN_PASSWORD} -lt 8 ] || ! [[ "$ADMIN_PASSWORD" =~ [A-Z] ]] || ! [[ "$ADMIN_PASSWORD" =~ [0-9] ]] \
        || ! [[ "$ADMIN_PASSWORD" =~ [^a-zA-Z0-9] ]]; then
    log_error "Password: at least 8 characters, one uppercase letter, one digit, one special character"
    exit 1
fi

INSTALL_DIR="/opt/madmin-hub"
DATA_DIR="$INSTALL_DIR/data"
SERVICE_USER="madmin-hub"
DB_NAME="madmin_hub"
DB_USER="madmin_hub"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PRIMARY_HOST="${HUB_HOSTS[0]:-${HUB_IPS[0]}}"

# --- Step 1: packages ---
log_info "Step 1/7: Installing packages..."
apt-get update
apt-get install -y postgresql postgresql-contrib libpq-dev python3-venv python3-dev python3-pip \
    build-essential libffi-dev nginx openssl curl

# --- Step 2: service user and database ---
log_info "Step 2/7: Service user and database..."
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
# Hub > Log reads the service journal
usermod -aG systemd-journal "$SERVICE_USER"

systemctl enable --now postgresql
if [ -f "$INSTALL_DIR/backend/.env" ]; then
    # Reinstall over an existing hub: keep the database and the keys
    DB_PASSWORD="$(sed -n 's#^DATABASE_URL=postgresql+asyncpg://[^:]*:\([^@]*\)@.*#\1#p' "$INSTALL_DIR/backend/.env")"
    SECRET_KEY="$(sed -n 's/^SECRET_KEY=//p' "$INSTALL_DIR/backend/.env")"
    log_warning "Existing installation found: database, SECRET_KEY and PKI are kept."
else
    DB_PASSWORD="$(openssl rand -hex 16)"
    SECRET_KEY="$(openssl rand -hex 32)"
    sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';" >/dev/null
    sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;" >/dev/null
fi

# --- Step 3: code and venv ---
log_info "Step 3/7: Deploying backend and frontend..."
mkdir -p "$INSTALL_DIR/backend" "$INSTALL_DIR/frontend" "$DATA_DIR"
cp -r "$PROJECT_DIR/backend/"* "$INSTALL_DIR/backend/"
cp -r "$PROJECT_DIR/frontend/"* "$INSTALL_DIR/frontend/"
if [ ! -x "$INSTALL_DIR/venv/bin/python3" ]; then
    python3 -m venv "$INSTALL_DIR/venv"
fi
"$INSTALL_DIR/venv/bin/pip" install --upgrade pip
"$INSTALL_DIR/venv/bin/pip" install -r "$INSTALL_DIR/backend/requirements.txt" \
    -c "$INSTALL_DIR/backend/requirements.lock"

cat > "$INSTALL_DIR/backend/.env" << EOF
DATABASE_URL=postgresql+asyncpg://$DB_USER:$DB_PASSWORD@localhost:5432/$DB_NAME
SECRET_KEY=$SECRET_KEY
DEBUG=false
DATA_DIR=$DATA_DIR
EOF
chown -R root:root "$INSTALL_DIR/backend" "$INSTALL_DIR/frontend"
chown root:"$SERVICE_USER" "$INSTALL_DIR/backend/.env"
chmod 640 "$INSTALL_DIR/backend/.env"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$DATA_DIR"
chmod 700 "$DATA_DIR"
chmod -R a+rX "$INSTALL_DIR/frontend"

# --- Step 4: PKI ---
log_info "Step 4/7: PKI..."
PKI_ARGS=()
for h in "${HUB_HOSTS[@]}"; do PKI_ARGS+=(--host "$h"); done
for i in "${HUB_IPS[@]}"; do PKI_ARGS+=(--ip "$i"); done
cd "$INSTALL_DIR/backend"
if [ -f "$DATA_DIR/pki/ca.pem" ]; then
    # Same CA (the instances pin it): only the endpoint certificate is redone
    sudo -u "$SERVICE_USER" "$INSTALL_DIR/venv/bin/python" -m hub.pki server-cert "${PKI_ARGS[@]}"
else
    sudo -u "$SERVICE_USER" "$INSTALL_DIR/venv/bin/python" -m hub.pki init "${PKI_ARGS[@]}"
fi
CA_FP="$(sudo -u "$SERVICE_USER" "$INSTALL_DIR/venv/bin/python" -m hub.pki fingerprint)"
cd - >/dev/null

# --- Step 5: nginx ---
log_info "Step 5/7: nginx..."
mkdir -p /etc/nginx/snippets
cat > /etc/nginx/snippets/madmin-hub-headers.conf << 'EOF'
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" always;
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
EOF

# Every proxied UI request: the agent certificate headers are blanked, so
# they can only ever come from the agent server below
cat > /etc/nginx/snippets/madmin-hub-proxy.conf << 'EOF'
proxy_pass http://127.0.0.1:8000;
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-SSL-Client-Verify "";
proxy_set_header X-SSL-Client-Cert "";
EOF

cat > /etc/nginx/sites-available/madmin-hub.conf << EOF
limit_req_zone \$binary_remote_addr zone=hub_login:1m rate=10r/m;
limit_req_zone \$binary_remote_addr zone=hub_enroll:1m rate=10r/m;

map \$http_upgrade \$connection_upgrade {
    default upgrade;
    ''      close;
}

# --- UI (operators) ---
server {
    listen $UI_PORT ssl;
    server_name _;
    ssl_certificate $DATA_DIR/pki/server.pem;
    ssl_certificate_key $DATA_DIR/pki/server.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    error_page 497 =301 https://\$host:\$server_port\$request_uri;
    client_max_body_size 4m;
    server_tokens off;
    include snippets/madmin-hub-headers.conf;
    root $INSTALL_DIR/frontend;

    location /agent/ { return 404; }
    location = /api/auth/init { return 404; }

    location /static/vendor {
        alias $INSTALL_DIR/frontend/assets/vendor;
        expires 1y;
        add_header Cache-Control "public, immutable";
        include snippets/madmin-hub-headers.conf;
    }
    location /static {
        alias $INSTALL_DIR/frontend/assets;
        add_header Cache-Control "no-cache";
        include snippets/madmin-hub-headers.conf;
    }
    location /api/auth/token {
        limit_req zone=hub_login burst=10 nodelay;
        limit_req_status 429;
        include snippets/madmin-hub-proxy.conf;
    }
    # Backup downloads can be large
    location /api/backups {
        proxy_read_timeout 600s;
        proxy_buffering off;
        include snippets/madmin-hub-proxy.conf;
    }
    location /api {
        proxy_read_timeout 120s;
        include snippets/madmin-hub-proxy.conf;
    }
    location /login { try_files /login.html =404; }
    location / { try_files \$uri \$uri/ /index.html; }
}

# --- Agent endpoint (instances, client certificates) ---
server {
    listen $AGENT_PORT ssl;
    server_name _;
    ssl_certificate $DATA_DIR/pki/server.pem;
    ssl_certificate_key $DATA_DIR/pki/server.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_client_certificate $DATA_DIR/pki/ca.pem;
    ssl_verify_client optional;
    ssl_verify_depth 1;
    server_tokens off;
    client_max_body_size 2g;

    location = /agent/enroll {
        limit_req zone=hub_enroll burst=5 nodelay;
        limit_req_status 429;
        client_max_body_size 256k;
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-SSL-Client-Verify "";
        proxy_set_header X-SSL-Client-Cert "";
    }
    location = /agent/ca.pem {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header X-SSL-Client-Verify "";
        proxy_set_header X-SSL-Client-Cert "";
    }
    location /agent/ {
        if (\$ssl_client_verify != SUCCESS) { return 403; }
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-SSL-Client-Verify \$ssl_client_verify;
        proxy_set_header X-SSL-Client-Cert \$ssl_client_escaped_cert;
        # Control channel and tunnels stay open; backups stream both ways
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
        proxy_request_buffering off;
    }
    location / { return 404; }
}
EOF
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/madmin-hub.conf /etc/nginx/sites-enabled/
nginx -t
systemctl enable nginx
systemctl restart nginx

# --- Step 6: systemd ---
log_info "Step 6/7: systemd service..."
cat > /etc/systemd/system/madmin-hub.service << EOF
[Unit]
Description=MADMIN Hub (FastAPI)
Wants=network-online.target postgresql.service
After=network-online.target postgresql.service

[Service]
Type=notify
NotifyAccess=main
WatchdogSec=120
TimeoutStartSec=120
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR/backend
# One worker: agent connections, support listeners, waiters and the login
# limiter live in this process. Never add --workers.
ExecStart=$INSTALL_DIR/venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000 --proxy-headers --forwarded-allow-ips=127.0.0.1 --ws-max-size 1048576
Restart=always
RestartSec=5
LimitNOFILE=65536
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable madmin-hub.service
systemctl restart madmin-hub.service

log_info "Waiting for the backend..."
READY="false"
for _ in $(seq 1 60); do
    if curl -sf -o /dev/null http://127.0.0.1:8000/api/health; then READY="true"; break; fi
    sleep 2
done
if [ "$READY" != "true" ]; then
    log_error "MADMIN Hub did not start. Check: journalctl -u madmin-hub -e"
    exit 1
fi

# --- Step 7: administrator and agent URL ---
log_info "Step 7/7: Administrator and settings..."
INIT_BODY=$(python3 -c "import json,sys; print(json.dumps({'username':sys.argv[1],'password':sys.argv[2]}))" "$ADMIN_USERNAME" "$ADMIN_PASSWORD")
INIT_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:8000/api/auth/init \
    -H "Content-Type: application/json" -d "$INIT_BODY")
case "$INIT_HTTP" in
    201) log_success "Administrator created: $ADMIN_USERNAME" ;;
    409) log_warning "An administrator already exists: not created again" ;;
    *)   log_error "Administrator not created (HTTP $INIT_HTTP)"; exit 1 ;;
esac

AGENT_URL="https://$PRIMARY_HOST:$AGENT_PORT"
LOGIN_BODY=$(python3 -c "import urllib.parse,sys; print(urllib.parse.urlencode({'username':sys.argv[1],'password':sys.argv[2],'grant_type':'password'}))" "$ADMIN_USERNAME" "$ADMIN_PASSWORD")
JWT=$(curl -s -X POST http://127.0.0.1:8000/api/auth/token -H "Content-Type: application/x-www-form-urlencoded" -d "$LOGIN_BODY" \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || true)
if [ -n "$JWT" ]; then
    curl -s -o /dev/null -X PATCH http://127.0.0.1:8000/api/settings/system \
        -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
        -d "{\"agent_url\": \"$AGENT_URL\"}" && log_success "Agent URL: $AGENT_URL"
else
    log_warning "Agent URL not set (login failed): set it in Settings ($AGENT_URL)"
fi

echo ""
log_success "=========================================="
log_success "   MADMIN HUB INSTALLED"
log_success "=========================================="
echo "UI:              https://$PRIMARY_HOST$([ "$UI_PORT" = 443 ] || echo ":$UI_PORT")"
echo "Agent endpoint:  $AGENT_URL"
echo "CA fingerprint:  $CA_FP"
echo ""
echo "Open towards this host: tcp/$UI_PORT (operators), tcp/$AGENT_PORT (instances),"
echo "tcp/9100-9119 (operators: support sessions, range configurable in Settings)."
echo ""
echo "Enroll an instance: create a token in Enrollment, save it to a file on the"
echo "instance and run setup-madmin.sh ... --hub-token-file <file>."
echo "Logs: journalctl -u madmin-hub -f"
