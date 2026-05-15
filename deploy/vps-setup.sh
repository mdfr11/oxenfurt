#!/usr/bin/env bash
# vps-setup.sh — First-time VPS bootstrap for Oxenfurt on Ubuntu.
#
# Installs: postgresql (apt default), Caddy (cloudsmith repo), Bun (curl
# installer), creates the `oxenfurt` service user, lays out /opt/oxenfurt,
# /etc/oxenfurt, /var/log/oxenfurt with correct ownership, and configures
# ufw. Idempotent — re-running is safe.
#
# Usage (as root):
#   scp deploy/vps-setup.sh root@VPS:/tmp/
#   ssh root@VPS bash /tmp/vps-setup.sh

set -euo pipefail

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "must run as root" >&2
    exit 1
  fi
}

step() { printf '\n==> %s\n' "$*"; }
ok() { printf '   ✓ %s\n' "$*"; }
skip() { printf '   • %s\n' "$*"; }

require_root

step "Detecting OS"
if [ ! -f /etc/os-release ]; then
  echo "/etc/os-release missing — unsupported OS" >&2
  exit 1
fi
. /etc/os-release
case "${ID:-}" in
  ubuntu) ok "Ubuntu ${VERSION_ID}" ;;
  debian) ok "Debian ${VERSION_ID} — treating as Ubuntu-compatible" ;;
  *) echo "this script targets Ubuntu/Debian; detected ID='${ID}'" >&2; exit 1 ;;
esac

step "Installing OS dependencies"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates \
  curl \
  debian-keyring \
  debian-archive-keyring \
  apt-transport-https \
  gnupg \
  rsync \
  ufw \
  unzip
ok "base tools present"

# --- PostgreSQL ---
step "Installing PostgreSQL (apt default)"
if ! command -v psql >/dev/null 2>&1; then
  apt-get install -y -qq postgresql postgresql-contrib
  systemctl enable --now postgresql
  ok "postgresql installed and started"
else
  skip "postgresql already installed"
fi

# --- Caddy ---
step "Installing Caddy (cloudsmith stable repo)"
if ! command -v caddy >/dev/null 2>&1; then
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
  ok "caddy installed and enabled"
else
  skip "caddy already installed"
fi

# --- Bun ---
step "Installing Bun (system-wide → /usr/local/bin/bun)"
if ! command -v bun >/dev/null 2>&1; then
  # Bun's installer honours BUN_INSTALL as the prefix.
  BUN_INSTALL=/usr/local SHELL=/bin/bash bash -c 'curl -fsSL https://bun.sh/install | bash'
  ok "bun → $(bun --version)"
else
  skip "bun already installed → $(bun --version)"
fi

# --- pnpm (used on the VPS only for `pnpm install --filter=...`) ---
step "Installing pnpm"
if ! command -v pnpm >/dev/null 2>&1; then
  npm_url='https://github.com/pnpm/pnpm/releases/latest/download/pnpm-linuxstatic-x64'
  curl -fsSL -o /usr/local/bin/pnpm "$npm_url"
  chmod +x /usr/local/bin/pnpm
  ok "pnpm → $(pnpm --version)"
else
  skip "pnpm already installed → $(pnpm --version)"
fi

# --- oxenfurt system user ---
step "Creating oxenfurt service user"
if ! id oxenfurt >/dev/null 2>&1; then
  useradd --system --home /opt/oxenfurt --shell /usr/sbin/nologin --user-group oxenfurt
  ok "user oxenfurt created"
else
  skip "user oxenfurt already exists"
fi

# --- Directory layout ---
step "Creating directory layout"
install -d -o oxenfurt -g oxenfurt -m 0755 /opt/oxenfurt
install -d -o oxenfurt -g oxenfurt -m 0755 /opt/oxenfurt/releases
install -d -o oxenfurt -g oxenfurt -m 0755 /opt/oxenfurt/mini-app
install -d -o oxenfurt -g oxenfurt -m 0750 /opt/oxenfurt/backups
install -d -o root      -g oxenfurt -m 0750 /etc/oxenfurt
install -d -o oxenfurt -g oxenfurt -m 0755 /var/log/oxenfurt
ok "/opt/oxenfurt, /etc/oxenfurt, /var/log/oxenfurt"

# --- Postgres database + role ---
step "Provisioning Postgres role + database"
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='oxenfurt'" | grep -q 1; then
  # Generate a strong password and stash it in /etc/oxenfurt/.pg_password for
  # the operator to read once and copy into backend.env.
  PG_PASS=$(openssl rand -hex 24)
  sudo -u postgres psql -c "CREATE ROLE oxenfurt WITH LOGIN PASSWORD '${PG_PASS}'"
  sudo -u postgres createdb -O oxenfurt oxenfurt
  umask 0177
  printf '%s\n' "$PG_PASS" > /etc/oxenfurt/.pg_password
  chown root:oxenfurt /etc/oxenfurt/.pg_password
  chmod 0640 /etc/oxenfurt/.pg_password
  ok "role 'oxenfurt' + database 'oxenfurt' created; password in /etc/oxenfurt/.pg_password"
else
  skip "role 'oxenfurt' already exists; not regenerating password"
fi

# --- ufw firewall ---
step "Configuring ufw"
if ufw status | grep -q 'Status: inactive'; then
  ufw --force default deny incoming
  ufw --force default allow outgoing
  ufw allow OpenSSH
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
  ok "ufw enabled (22, 80, 443)"
else
  ufw allow OpenSSH >/dev/null || true
  ufw allow 80/tcp >/dev/null || true
  ufw allow 443/tcp >/dev/null || true
  skip "ufw already active; ensured 22/80/443 are allowed"
fi

# --- Caddy: drop default site, prepare for our Caddyfile ---
step "Preparing Caddy"
if [ -f /etc/caddy/Caddyfile ]; then
  if grep -q "^# Oxenfurt" /etc/caddy/Caddyfile; then
    skip "Caddyfile already managed by Oxenfurt"
  else
    cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.dist-$(date +%s).bak
    ok "backed up default Caddyfile"
  fi
fi
ok "ready for: copy deploy/Caddyfile → /etc/caddy/Caddyfile (after setting your domain)"

# --- Final hints ---
cat <<'MSG'

==> VPS bootstrap complete.

Next steps (manual):

  1. Read the Postgres password the installer stashed and add it to your
     backend.env (alongside other secrets):
       cat /etc/oxenfurt/.pg_password

  2. Copy the secrets template, fill in real values, install:
       cp /tmp/oxenfurt-deploy/env/backend.env.example /etc/oxenfurt/backend.env
       editor /etc/oxenfurt/backend.env
       chown root:oxenfurt /etc/oxenfurt/backend.env && chmod 0640 /etc/oxenfurt/backend.env

  3. Point your domain's A record at this VPS, then install the Caddyfile:
       editor /tmp/oxenfurt-deploy/Caddyfile      # set your domain
       cp /tmp/oxenfurt-deploy/Caddyfile /etc/caddy/Caddyfile
       systemctl reload caddy

  4. Install systemd units and run the first deploy from your laptop:
       cp /tmp/oxenfurt-deploy/systemd/*.service /etc/systemd/system/
       cp /tmp/oxenfurt-deploy/systemd/*.timer   /etc/systemd/system/
       systemctl daemon-reload
       systemctl enable --now oxenfurt-backup.timer
       # backend.service is started by deploy.sh after the first rsync.

  5. From your laptop:
       ./deploy/deploy.sh

  6. Wire Hermes — see deploy/hermes/integration.md.

MSG
