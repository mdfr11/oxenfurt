#!/usr/bin/env bash
# install.sh — One-shot installer for Oxenfurt on a fresh Ubuntu/Debian VPS.
#
# What it does:
#   1. Verifies you're root and on a supported distro.
#   2. Runs vps-setup.sh to install prereqs (Bun, pnpm, Postgres, Caddy,
#      ufw) and create the service user + directory layout.
#   3. Asks interactively for:
#        - Telegram BOT_TOKEN
#        - OWNER_TELEGRAM_USER_ID
#        - Public domain (e.g. yourapp.duckdns.org)
#        - Operator email (for Let's Encrypt notices)
#        - Optional LLM provider (skip for no AI features)
#   4. Generates JWT_SECRET and INGEST_TOKEN with openssl.
#   5. Writes /etc/oxenfurt/backend.env atomically with all values.
#   6. Templates the Caddyfile with your domain + email and reloads Caddy.
#   7. Installs systemd units (backend service + nightly backup timer).
#   8. Builds the repo on the VPS (bun + pnpm + vite) into a fresh release
#      dir, runs DB migrations, symlinks /opt/oxenfurt/current.
#   9. Starts oxenfurt-backend, hits /api/health, prints status.
#
# Usage (as root on a fresh VPS):
#   curl -fsSL https://raw.githubusercontent.com/<you>/oxenfurt/master/deploy/install.sh \
#     | bash
#
# Or if you've already cloned the repo:
#   sudo bash deploy/install.sh
#
# Non-interactive (CI / automation):
#   export OXENFURT_BOT_TOKEN=… OXENFURT_OWNER_ID=… OXENFURT_DOMAIN=…
#   export OXENFURT_EMAIL=… OXENFURT_NON_INTERACTIVE=1
#   sudo -E bash deploy/install.sh

set -euo pipefail

# --- Display helpers --------------------------------------------------------

bold='\033[1m'; dim='\033[2m'; green='\033[32m'; red='\033[31m'; yellow='\033[33m'; reset='\033[0m'
step()  { printf "\n${bold}==> %s${reset}\n" "$*"; }
ok()    { printf "   ${green}✓${reset} %s\n" "$*"; }
skip()  { printf "   ${dim}•${reset} %s\n" "$*"; }
warn()  { printf "   ${yellow}!${reset} %s\n" "$*" >&2; }
fail()  { printf "   ${red}✗${reset} %s\n" "$*" >&2; exit 1; }
ask()   { printf "${bold}%s${reset} " "$*"; }

# --- Preflight --------------------------------------------------------------

[[ "$(id -u)" -eq 0 ]] || fail "must run as root (try: sudo $0)"

# Source the repository — either we're inside it, or we clone it now.
REPO_URL="${OXENFURT_REPO_URL:-https://github.com/mdfr11/oxenfurt.git}"
REPO_BRANCH="${OXENFURT_REPO_BRANCH:-master}"
WORK_DIR="${OXENFURT_WORK_DIR:-/opt/oxenfurt/source}"

step "Locating Oxenfurt source"
if [[ -f "$(dirname "$0")/vps-setup.sh" ]]; then
  SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
  ok "running from existing checkout: ${SOURCE_DIR}"
else
  apt-get install -y -qq git 2>&1 | grep -v '^$' || true
  if [[ -d "${WORK_DIR}/.git" ]]; then
    git -C "${WORK_DIR}" fetch --quiet --depth 1 origin "${REPO_BRANCH}"
    git -C "${WORK_DIR}" reset --hard --quiet "origin/${REPO_BRANCH}"
    ok "refreshed ${WORK_DIR} to origin/${REPO_BRANCH}"
  else
    install -d -m 0755 "$(dirname "$WORK_DIR")"
    git clone --depth 1 --branch "${REPO_BRANCH}" --quiet "${REPO_URL}" "${WORK_DIR}"
    ok "cloned ${REPO_URL} → ${WORK_DIR}"
  fi
  SOURCE_DIR="${WORK_DIR}"
fi

# --- Prereqs (delegated to vps-setup.sh) -----------------------------------

step "Running prereqs bootstrap (vps-setup.sh)"
bash "${SOURCE_DIR}/deploy/vps-setup.sh"

# --- Collect config interactively ------------------------------------------

NON_INTERACTIVE="${OXENFURT_NON_INTERACTIVE:-0}"

prompt() {
  # $1 = friendly question, $2 = env-var name, $3 = (optional) validator regex,
  # $4 = (optional) hint string shown on validator failure
  local question="$1" varname="$2" regex="${3:-}" hint="${4:-}"
  local current="${!varname:-}"
  if [[ -n "$current" ]]; then
    ok "${varname}=${current:0:40}…"
    return
  fi
  if [[ "$NON_INTERACTIVE" == "1" ]]; then
    fail "${varname} required in non-interactive mode but unset"
  fi
  while true; do
    ask "$question"
    read -r value
    if [[ -z "$value" ]]; then
      warn "empty — try again"; continue
    fi
    if [[ -n "$regex" && ! "$value" =~ $regex ]]; then
      warn "${hint:-invalid format}"; continue
    fi
    printf -v "$varname" '%s' "$value"
    break
  done
}

step "Configuration"
prompt "Telegram bot token (from @BotFather):"            OXENFURT_BOT_TOKEN '^[0-9]+:[A-Za-z0-9_-]{30,}$' "looks like '1234567890:ABCdefGhIJKlmNoPQRstUvWxYz'"
prompt "Your Telegram user ID (from @userinfobot):"       OXENFURT_OWNER_ID  '^[0-9]+$'                     "digits only"
prompt "Public domain (e.g. oxenfurt.duckdns.org):"       OXENFURT_DOMAIN    '^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$' "lowercase domain"
prompt "Email for Let's Encrypt notices:"                 OXENFURT_EMAIL     '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' "looks like name@example.com"

# Optional LLM block — single y/n then three reads.
LLM_API_BASE_URL=""; LLM_API_KEY=""; LLM_MODEL=""
if [[ -z "${OXENFURT_LLM_API_KEY:-}" && "$NON_INTERACTIVE" != "1" ]]; then
  ask "Enable AI grading? (y/N):"
  read -r yn
  if [[ "$yn" =~ ^[Yy]$ ]]; then
    prompt "LLM_API_BASE_URL (e.g. https://api.moonshot.cn/v1):" OXENFURT_LLM_API_BASE_URL '^https?://' "must start with http:// or https://"
    prompt "LLM_API_KEY:"                                        OXENFURT_LLM_API_KEY      '.{8,}'      "at least 8 chars"
    prompt "LLM_MODEL (e.g. moonshot-v1-8k):"                    OXENFURT_LLM_MODEL        '.+'        "non-empty"
    LLM_API_BASE_URL="$OXENFURT_LLM_API_BASE_URL"
    LLM_API_KEY="$OXENFURT_LLM_API_KEY"
    LLM_MODEL="$OXENFURT_LLM_MODEL"
  fi
else
  LLM_API_BASE_URL="${OXENFURT_LLM_API_BASE_URL:-}"
  LLM_API_KEY="${OXENFURT_LLM_API_KEY:-}"
  LLM_MODEL="${OXENFURT_LLM_MODEL:-}"
fi

# --- Generate secrets -------------------------------------------------------

step "Generating app secrets"
JWT_SECRET="$(openssl rand -base64 32 | tr -d '\n')"
INGEST_TOKEN="$(openssl rand -hex 32)"
ok "JWT_SECRET and INGEST_TOKEN generated"

# --- Postgres password (already created by vps-setup.sh) -------------------

step "Reading Postgres password"
[[ -r /etc/oxenfurt/.pg_password ]] || fail "/etc/oxenfurt/.pg_password missing (vps-setup.sh didn't run cleanly?)"
PG_PASS="$(cat /etc/oxenfurt/.pg_password)"
ok "got postgres password from /etc/oxenfurt/.pg_password"

# --- Write /etc/oxenfurt/backend.env atomically ---------------------------

step "Writing /etc/oxenfurt/backend.env"
ENV_TMP="$(mktemp)"
cat > "$ENV_TMP" <<EOF
# Auto-generated by deploy/install.sh on $(date -u +%FT%TZ)
# Edit by hand AFTER install if you need to change values.

BOT_TOKEN=${OXENFURT_BOT_TOKEN}
OWNER_TELEGRAM_USER_ID=${OXENFURT_OWNER_ID}

JWT_SECRET=${JWT_SECRET}
INGEST_TOKEN=${INGEST_TOKEN}

DATABASE_URL=postgres://oxenfurt:${PG_PASS}@127.0.0.1:5432/oxenfurt

PORT=3000
INITDATA_MAX_AGE_SECONDS=3600
JWT_TTL_SECONDS=900

NODE_ENV=production
ENABLE_DEV_AUTH=false

# Optional AI provider (OpenAI-compatible). Leave blank to disable
# semantic grading; /grade will return 503 llm_not_configured.
LLM_API_BASE_URL=${LLM_API_BASE_URL}
LLM_API_KEY=${LLM_API_KEY}
LLM_MODEL=${LLM_MODEL}

# Backup retention (deploy/backup.sh).
BACKUP_RETENTION_DAYS=14
BACKUP_RCLONE_REMOTE=
EOF
install -o root -g oxenfurt -m 0640 "$ENV_TMP" /etc/oxenfurt/backend.env
rm -f "$ENV_TMP"
ok "wrote /etc/oxenfurt/backend.env (mode 0640, root:oxenfurt)"

# --- Caddyfile with the user's domain --------------------------------------

step "Installing Caddyfile"
CADDY_TMP="$(mktemp)"
sed \
  -e "s|oxenfurt.example.com|${OXENFURT_DOMAIN}|g" \
  -e "s|you@example.com|${OXENFURT_EMAIL}|g" \
  "${SOURCE_DIR}/deploy/Caddyfile" > "$CADDY_TMP"
install -m 0644 "$CADDY_TMP" /etc/caddy/Caddyfile
rm -f "$CADDY_TMP"
ok "wrote /etc/caddy/Caddyfile for domain ${OXENFURT_DOMAIN}"

# --- Systemd units ----------------------------------------------------------

step "Installing systemd units"
install -m 0644 "${SOURCE_DIR}"/deploy/systemd/*.service /etc/systemd/system/
install -m 0644 "${SOURCE_DIR}"/deploy/systemd/*.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now oxenfurt-backup.timer >/dev/null 2>&1 || true
ok "units installed; oxenfurt-backup.timer enabled"

# --- Stage release directory + build on VPS --------------------------------

step "Staging release directory"
TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
REL_DIR="/opt/oxenfurt/releases/${TIMESTAMP}"
install -d -o oxenfurt -g oxenfurt -m 0755 "$REL_DIR"
rsync -a \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='.git/' \
  --exclude='*.tsbuildinfo' \
  "${SOURCE_DIR}/" \
  "${REL_DIR}/"
chown -R oxenfurt:oxenfurt "$REL_DIR"
ok "release at ${REL_DIR}"

step "Installing dependencies (pnpm + bun)"
sudo -u oxenfurt env \
  HOME=/opt/oxenfurt \
  TMPDIR=/opt/oxenfurt/.tmp \
  PATH=/usr/local/bin:/usr/bin:/bin \
  pnpm install --frozen-lockfile --dir "${REL_DIR}" >/dev/null 2>&1
ok "deps installed"

step "Building mini-app (vite)"
sudo -u oxenfurt env \
  HOME=/opt/oxenfurt \
  TMPDIR=/opt/oxenfurt/.tmp \
  PATH=/usr/local/bin:/usr/bin:/bin \
  VITE_API_URL='' \
  pnpm --filter=@oxenfurt/mini-app --dir "${REL_DIR}" build 2>&1 | tail -3
install -d -o oxenfurt -g oxenfurt -m 0755 /opt/oxenfurt/mini-app
rsync -a --delete "${REL_DIR}/apps/mini-app/dist/" /opt/oxenfurt/mini-app/
chown -R oxenfurt:oxenfurt /opt/oxenfurt/mini-app
ok "mini-app deployed to /opt/oxenfurt/mini-app"

step "Running database migrations"
# shellcheck disable=SC1091
set -a; source /etc/oxenfurt/backend.env; set +a
sudo -u oxenfurt env \
  HOME=/opt/oxenfurt \
  PATH=/usr/local/bin:/usr/bin:/bin \
  DATABASE_URL="${DATABASE_URL}" \
  bun "${REL_DIR}/apps/backend/src/db/migrate.ts" 2>&1 | tail -3 || \
  fail "migrations failed — see output above"
ok "migrations applied"

step "Switching symlink to new release"
ln -sfn "$REL_DIR" /opt/oxenfurt/current
ok "/opt/oxenfurt/current → ${REL_DIR##*/}"

# --- Start services ---------------------------------------------------------

step "Starting services"
systemctl restart oxenfurt-backend.service
systemctl reload caddy.service || systemctl restart caddy.service
sleep 2
systemctl is-active --quiet oxenfurt-backend.service || \
  fail "oxenfurt-backend failed to start; check: journalctl -u oxenfurt-backend -n 50"
ok "oxenfurt-backend active"

# --- Healthcheck ------------------------------------------------------------

step "Healthcheck"
sleep 1
# Backend listens directly on 127.0.0.1:3000 and exposes /health (no
# /api prefix — that namespace exists only at the Caddy layer for the
# public surface).
if HEALTH_LOCAL="$(curl -sf --max-time 5 http://127.0.0.1:3000/health 2>&1)"; then
  echo "   loopback: ${HEALTH_LOCAL}"
  ok "backend healthy on loopback"
else
  warn "loopback probe failed — check: journalctl -u oxenfurt-backend -n 50"
fi

# Public probe through Caddy. First-cert issuance and DNS propagation can
# take a minute; we warn rather than fail because the install is otherwise
# complete and the user may have set up DNS just now.
if curl -sf --max-time 8 "https://${OXENFURT_DOMAIN}/api/health" >/dev/null 2>&1; then
  ok "public endpoint live at https://${OXENFURT_DOMAIN}"
elif curl -sf --max-time 8 "https://${OXENFURT_DOMAIN}/health" >/dev/null 2>&1; then
  ok "public endpoint live at https://${OXENFURT_DOMAIN}"
else
  warn "public probe failed — likely DNS hasn't propagated or cert is still being issued"
  warn "tail Caddy: journalctl -u caddy -f  (look for 'certificate obtained')"
fi

# --- Final summary ---------------------------------------------------------

cat <<MSG

${bold}=== Oxenfurt is installed ===${reset}

  Mini App will be served at:   ${green}https://${OXENFURT_DOMAIN}${reset}
  Backend listening on:         127.0.0.1:3000 (loopback only)
  Service:                      systemctl status oxenfurt-backend
  Logs:                         journalctl -u oxenfurt-backend -f
  Backend env:                  /etc/oxenfurt/backend.env (root:oxenfurt 0640)
  Source release:               ${REL_DIR}
  Mini App static:              /opt/oxenfurt/mini-app

  ${bold}Next steps:${reset}
    1. Point your Telegram bot's Menu Button at https://${OXENFURT_DOMAIN}
       (via @BotFather → Bot Settings → Menu Button)
    2. Open the bot in Telegram → tap the menu — you should see the app.
    3. To ingest cards from your own agent, POST to
       https://${OXENFURT_DOMAIN}/api/ingest/cards with header
       'Authorization: Bearer ${INGEST_TOKEN}'
       (also stored in /etc/oxenfurt/backend.env)

  ${dim}Manual update later: cd ${SOURCE_DIR} && git pull && sudo bash deploy/install.sh${reset}

MSG
