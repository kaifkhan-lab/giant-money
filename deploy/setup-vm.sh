#!/usr/bin/env bash
# Giant Money — one-shot setup for a fresh Ubuntu VM.
#
# Works on any always-free VM with a real disk: Google Cloud e2-micro,
# Oracle Cloud Always Free, AWS t3.micro, or any VPS.
#
# Usage, from the VM's own shell:# Usage, from the VM's own shell:# Usage, from the VM's own shell:
#   curl -fsSL https://raw.githubusercontent.com/YOUR_USERNAME/giant-money/main/deploy/setup-vm.sh | bash -s -- YOUR_USERNAME your@email.com
#
# Or clone first and run ./deploy/setup-vm.sh YOUR_USERNAME your@email.com
set -euo pipefail

GH_USER="${1:-}"
CONTACT="${2:-}"
APP_DIR="/opt/giant-money"
DATA_DIR="/var/lib/giant-money"
SERVICE="giant-money"

if [[ -z "$GH_USER" || -z "$CONTACT" ]]; then
  echo "Usage: $0 <github-username> <your-email>"
  echo "  the email is declared to SEC EDGAR, which throttles anonymous callers"
  exit 1
fi

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$1"; }

say "Installing Node 22 and build tools"
# better-sqlite3 is a native addon, so python3/make/g++ must be present
sudo apt-get update -qq
sudo apt-get install -y -qq curl git ca-certificates python3 make g++ >/dev/null
if ! command -v node >/dev/null || [[ "$(node -v | cut -c2-3)" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi
echo "    node $(node -v), npm $(npm -v)"

say "Fetching the code into $APP_DIR"
sudo mkdir -p "$APP_DIR"
sudo chown "$USER":"$USER" "$APP_DIR"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "https://github.com/$GH_USER/giant-money.git" "$APP_DIR"
fi

say "Installing dependencies (compiles better-sqlite3)"
cd "$APP_DIR"
npm ci --omit=dev

say "Creating the data directory on disk (survives reboots)"
sudo mkdir -p "$DATA_DIR"
sudo chown "$USER":"$USER" "$DATA_DIR"

say "Writing the systemd service"
# systemd is what makes this genuinely always-on: it starts the app at boot and
# restarts it if it ever crashes, which is what the 24/7 filing loop needs.
sudo tee "/etc/systemd/system/$SERVICE.service" >/dev/null <<UNIT
[Unit]
Description=Giant Money — live smart-money intelligence
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=8080
Environment=DATA_DIR=$DATA_DIR
Environment=SEC_USER_AGENT=GIANT-MONEY research $CONTACT
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
# keep the journal readable rather than unbounded
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

say "Starting the service"
sudo systemctl daemon-reload
sudo systemctl enable --now "$SERVICE"
sleep 6

say "Checking it came up"
if curl -fsS --max-time 10 http://127.0.0.1:8080/healthz >/dev/null; then
  echo "    healthz OK"
else
  echo "    NOT healthy yet — see: sudo journalctl -u $SERVICE -n 50 --no-pager"
fi

say "Putting nginx in front on port 80"
sudo apt-get install -y -qq nginx >/dev/null
sudo tee /etc/nginx/sites-available/giant-money >/dev/null <<'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    # generous timeouts: some SEC and FINRA pulls are slow
    proxy_connect_timeout 30s;
    proxy_read_timeout    120s;
    client_max_body_size  2m;

    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
NGINX
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sf /etc/nginx/sites-available/giant-money /etc/nginx/sites-enabled/giant-money
sudo nginx -t && sudo systemctl restart nginx

IP="$(curl -fsS --max-time 5 https://api.ipify.org || echo '<your-vm-ip>')"
cat <<DONE

────────────────────────────────────────────────────────────
 Giant Money is live:  http://$IP

 Remember to open port 80 in the cloud firewall:
   Google Cloud  → VPC network → Firewall → allow tcp:80
   Oracle Cloud  → VCN → Security List → ingress tcp:80

 Useful commands
   sudo systemctl status $SERVICE       # is it running
   sudo journalctl -u $SERVICE -f       # live logs
   sudo systemctl restart $SERVICE      # restart

 Update to the latest code
   cd $APP_DIR && git pull && npm ci --omit=dev && sudo systemctl restart $SERVICE

 The database lives in $DATA_DIR and survives reboots and updates.
────────────────────────────────────────────────────────────
DONE
