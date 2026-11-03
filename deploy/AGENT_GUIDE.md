# Oxenfurt — Agent Deployment Guide

Read this end-to-end before running anything. Stages are sequential —
later stages assume earlier ones completed successfully.

Target environment: **Ubuntu 22.04 or 24.04** VPS with ≥ 2 GB RAM,
public IPv4, root or sudo access, and an existing
`hermes-english.service` (Hermes Agent by NousResearch) already running
on this same host.

The deploy you're performing brings up **Oxenfurt** — a Telegram Mini App
backend + static mini-app — alongside Hermes. Both processes will live
on this VPS, communicate over loopback, and share the system Caddy + ufw
for ingress.

You are the agent. You have a shell on the VPS. The human operator will
provide you the secrets listed in *Stage 0* and perform a couple of
Telegram-UI steps in *Stage 8* that no agent can do for them.

---

## Stage 0 — Inputs required from the human

You **cannot** proceed without all of these. If any is missing, ask the
operator before running commands.

| Variable                  | What it is | Where the operator gets it |
|---------------------------|------------|----------------------------|
| `DOMAIN`                  | Public hostname the Mini App will live at | A registrar (Porkbun, Namecheap, Cloudflare) **or** free DuckDNS (see "Free domain via DuckDNS" below). A DNS A-record must already point at this VPS's public IP. Verify with `dig +short A "$DOMAIN"`. |
| `BOT_TOKEN`               | Telegram bot token from `@BotFather` | The operator already has a bot for the `english` Hermes profile — re-use the same token. |
| `OWNER_TELEGRAM_USER_ID`  | The operator's numeric Telegram user ID | `/start` to `@userinfobot` in Telegram. |
| `REPO_URL`                | git URL of the Oxenfurt repository | The operator either pushed to GitHub/GitLab or will scp a tarball — confirm. |
| `OPERATOR_EMAIL`          | Email for Let's Encrypt ACME registration / expiry warnings | Operator's address. Used once in Caddyfile. |

Optional:

| Variable | Purpose | Default if not supplied |
|----------|---------|-------------------------|
| `BACKUP_RCLONE_REMOTE` | rclone remote name for off-site backups | empty → backups stay local |

Persist these in a temp shell file you can `source` later — keeps later
commands declarative:

```bash
cat > /root/oxenfurt-inputs.env <<'EOF'
DOMAIN=oxenfurt.example.com
BOT_TOKEN=PASTE_BOT_TOKEN
OWNER_TELEGRAM_USER_ID=000000000
REPO_URL=git@github.com:operator/oxenfurt.git
OPERATOR_EMAIL=you@example.com
BACKUP_RCLONE_REMOTE=
EOF
chmod 0600 /root/oxenfurt-inputs.env
source /root/oxenfurt-inputs.env
```

Sanity-check DNS resolves to this host:

```bash
test "$(dig +short A "$DOMAIN" | head -1)" = "$(curl -s https://api.ipify.org)" \
  && echo "DNS OK" || echo "DNS NOT pointing here — fix before continuing"
```

If the check fails, stop and tell the operator: TLS via Let's Encrypt
requires this to resolve correctly before Caddy starts.

### Free domain via DuckDNS (recommended for personal-use deploys)

If the operator hasn't bought a domain and isn't planning to share this
Mini App publicly, DuckDNS is the path. `$0/year`, no email verification,
stable since 2014. Telegram BotFather accepts `*.duckdns.org` for Mini
Apps, and Caddy obtains a Let's Encrypt cert via HTTP-01 with no extra
configuration.

Have the operator do this once **before** Stage 1:

1. Open https://www.duckdns.org and log in via GitHub / Google / Reddit / Twitter.
2. Pick a subdomain name (e.g. `oxenfurt-mdfr`) and click **add domain**.
   The resulting hostname is `oxenfurt-mdfr.duckdns.org`.
3. Paste the VPS's public IP into the "current ip" box and click
   **update ip**.
4. Wait ~30 seconds, then verify from your shell:
   ```bash
   dig +short A oxenfurt-mdfr.duckdns.org
   # Must return the VPS's public IP.
   ```

Then in `/root/oxenfurt-inputs.env`:

```
DOMAIN=oxenfurt-mdfr.duckdns.org
```

The rest of the guide works without changes — Caddy doesn't care that
the apex is `duckdns.org` instead of a paid TLD.

Migration to a real domain later is one Caddyfile edit + one
`@BotFather /setdomain` round-trip; the backend and database don't move.

### Off-site backups

If the operator doesn't want or have an S3/R2 account, leave
`BACKUP_RCLONE_REMOTE=` empty in `oxenfurt-inputs.env`. Daily backups
will still run and rotate locally at `/opt/oxenfurt/backups/`. For a
single-user personal deploy this is acceptable risk; if you ever do want
off-site, install `rclone`, configure a remote, and set the variable in
`/etc/oxenfurt/backend.env`.

---

## Stage 1 — Get the code onto the VPS

You need the repository at a stable working location. Use `/root/oxenfurt-src`
for the working clone; the deploy will create release directories under
`/opt/oxenfurt/releases/` separately.

```bash
apt-get update -qq && apt-get install -y -qq git rsync
mkdir -p /root
git clone "$REPO_URL" /root/oxenfurt-src
cd /root/oxenfurt-src
```

If the repository is private and uses SSH, ask the operator to add the
VPS host key to their deploy keys, or have them paste a deploy SSH key
into `/root/.ssh/id_ed25519` (mode 0600).

If the operator used a tarball instead of git:

```bash
# Expect /tmp/oxenfurt.tar.gz uploaded via scp
mkdir -p /root/oxenfurt-src
tar -xzf /tmp/oxenfurt.tar.gz -C /root/oxenfurt-src --strip-components=1
cd /root/oxenfurt-src
```

Verify the layout matches what the deploy scripts expect:

```bash
ls deploy/{vps-setup.sh,deploy.sh,Caddyfile,backup.sh} \
   deploy/systemd/oxenfurt-backend.service \
   apps/backend/src/index.ts \
   apps/mini-app/package.json \
   packages/shared/package.json \
  >/dev/null && echo "layout OK" || echo "layout broken — abort"
```

---

## Stage 2 — Bootstrap the VPS

This installs Postgres, Caddy, Bun, pnpm; creates the `oxenfurt` system
user; lays out `/opt/oxenfurt`, `/etc/oxenfurt`, `/var/log/oxenfurt`;
provisions a Postgres role + database; enables ufw with 22/80/443. It is
idempotent — re-running is safe.

```bash
bash /root/oxenfurt-src/deploy/vps-setup.sh
```

Expected output ends with `==> VPS bootstrap complete.` and a list of
manual next steps (which this guide automates below — ignore them in
the script output, follow this document instead).

### Verify

```bash
# Tools present
command -v bun && command -v pnpm && command -v caddy && command -v psql

# oxenfurt user exists
id oxenfurt

# Directories created with right ownership
namei -lx /opt/oxenfurt /etc/oxenfurt /var/log/oxenfurt

# Postgres role + DB
sudo -u postgres psql -tAc "SELECT rolname FROM pg_roles WHERE rolname='oxenfurt';" \
  | grep -q oxenfurt && echo "role OK"
sudo -u postgres psql -tAc "SELECT datname FROM pg_database WHERE datname='oxenfurt';" \
  | grep -q oxenfurt && echo "db OK"

# Postgres password stashed for backend.env
test -s /etc/oxenfurt/.pg_password && echo "pg password OK"

# ufw active with 80/443 open
ufw status verbose | grep -E '(80|443)/tcp.*ALLOW' && echo "ufw OK"
```

If any verification fails, re-run the script and watch for the error.
Common failure modes:

- `apt-get` lock held by unattended-upgrades: wait 2 min, retry.
- Caddy repo signing fails: check the VPS clock with `timedatectl
  status` — if drift > 5 min, run `timedatectl set-ntp true` first.

---

## Stage 3 — Configure backend secrets

Build the `/etc/oxenfurt/backend.env` from the template and the inputs
from Stage 0.

```bash
source /root/oxenfurt-inputs.env

PG_PASS=$(cat /etc/oxenfurt/.pg_password)
JWT_SECRET=$(openssl rand -base64 32)
INGEST_TOKEN=$(openssl rand -hex 32)

install -o root -g oxenfurt -m 0640 /dev/stdin /etc/oxenfurt/backend.env <<EOF
BOT_TOKEN=${BOT_TOKEN}
OWNER_TELEGRAM_USER_ID=${OWNER_TELEGRAM_USER_ID}
JWT_SECRET=${JWT_SECRET}
INGEST_TOKEN=${INGEST_TOKEN}
DATABASE_URL=postgres://oxenfurt:${PG_PASS}@127.0.0.1:5432/oxenfurt
PORT=3000
INITDATA_MAX_AGE_SECONDS=3600
JWT_TTL_SECONDS=900
NODE_ENV=production
ENABLE_DEV_AUTH=false
BACKUP_RETENTION_DAYS=14
BACKUP_RCLONE_REMOTE=${BACKUP_RCLONE_REMOTE:-}
EOF

ls -l /etc/oxenfurt/backend.env
```

The same `INGEST_TOKEN` will be used by Hermes in Stage 7 — note it down
or read it later from this file. Don't leak `JWT_SECRET` or
`INGEST_TOKEN` anywhere outside `/etc/oxenfurt/`.

Optional multi-scope keys (`SCOPES`, `INGEST_TOKENS`) are documented in
`env/backend.env.example`; the full second-agent walkthrough lives in
`hermes/integration.md` → "Adding a scope". A single-scope install needs
neither — the app boots with one default `english` scope that owns
`INGEST_TOKEN`.

### Verify

```bash
# Permissions are 0640, root:oxenfurt
stat -c '%a %U:%G' /etc/oxenfurt/backend.env  # expect: 640 root:oxenfurt

# All required keys present, no empty values
grep -E '^(BOT_TOKEN|OWNER_TELEGRAM_USER_ID|JWT_SECRET|INGEST_TOKEN|DATABASE_URL|PORT|NODE_ENV|ENABLE_DEV_AUTH)=' /etc/oxenfurt/backend.env \
  | awk -F= '{if (length($2) == 0) {print "EMPTY: " $1; exit 1}} END {print "all keys set"}'

# Optional scope keys — present only on multi-scope installs; if INGEST_TOKENS
# exists, every slug in it must also appear in SCOPES
grep -E '^(SCOPES|INGEST_TOKENS)=' /etc/oxenfurt/backend.env || echo "single-scope install (no SCOPES keys)"
```

---

## Stage 4 — Install systemd units

```bash
cd /root/oxenfurt-src
install -m 0644 deploy/systemd/oxenfurt-backend.service  /etc/systemd/system/
install -m 0644 deploy/systemd/oxenfurt-backup.service   /etc/systemd/system/
install -m 0644 deploy/systemd/oxenfurt-backup.timer     /etc/systemd/system/

systemctl daemon-reload

# Enable the backup timer; backend will be started after the first deploy.
systemctl enable --now oxenfurt-backup.timer
systemctl is-active oxenfurt-backup.timer  # expect: active
```

The backend service is **not** started yet — there's no code under
`/opt/oxenfurt/current` to run. Stage 6 fixes that.

---

## Stage 5 — Configure Caddy

```bash
source /root/oxenfurt-inputs.env

# Build the live Caddyfile from the template
sed \
  -e "s|oxenfurt.example.com|${DOMAIN}|g" \
  -e "s|you@example.com|${OPERATOR_EMAIL}|g" \
  /root/oxenfurt-src/deploy/Caddyfile \
  > /etc/caddy/Caddyfile

caddy validate --config /etc/caddy/Caddyfile && echo "Caddyfile valid"

systemctl reload caddy
systemctl status caddy --no-pager | head -6
```

Caddy will obtain a Let's Encrypt cert on the first request. Watch for
ACME success:

```bash
journalctl -u caddy --since '1 minute ago' --no-pager | grep -E '(certificate obtained|tls-alpn-01)'
```

If you see `failed to obtain certificate`:

- DNS may have just propagated but not from Let's Encrypt's resolvers
  yet — wait 5 min and `systemctl reload caddy`.
- ufw not allowing 80 inbound: run `ufw status` and ensure `80/tcp ALLOW`.

The first hit to `https://${DOMAIN}/` will return 404 (mini-app not
installed yet) — that's expected at this stage.

---

## Stage 6 — First deploy of code

This installs runtime deps on the VPS, runs migrations, builds the
mini-app, and starts the backend.

```bash
source /root/oxenfurt-inputs.env

RELEASE="$(date -u +%Y%m%d-%H%M%S)"
REL_DIR="/opt/oxenfurt/releases/${RELEASE}"

install -d -o oxenfurt -g oxenfurt -m 0755 "${REL_DIR}"

# Copy the current working tree into the new release dir, excluding caches.
rsync -a \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='.git/' \
  --exclude='*.tsbuildinfo' \
  /root/oxenfurt-src/ "${REL_DIR}/"

chown -R oxenfurt:oxenfurt "${REL_DIR}"

# Install backend deps as the oxenfurt user.
cd "${REL_DIR}"
sudo -u oxenfurt env PATH="/usr/local/bin:$PATH" \
  pnpm install --frozen-lockfile --filter=@oxenfurt/backend... --prod

# Build the mini-app (VITE_API_URL='' → same-origin via Caddy at /api).
sudo -u oxenfurt env PATH="/usr/local/bin:$PATH" \
  pnpm install --frozen-lockfile --filter=@oxenfurt/mini-app...
sudo -u oxenfurt env PATH="/usr/local/bin:$PATH" VITE_API_URL='' \
  pnpm --filter=@oxenfurt/mini-app build

# Move the built dist into the public path Caddy serves.
rsync -a --delete "${REL_DIR}/apps/mini-app/dist/" /opt/oxenfurt/mini-app/
chown -R oxenfurt:oxenfurt /opt/oxenfurt/mini-app

# Apply Drizzle migrations.
set -a; source /etc/oxenfurt/backend.env; set +a
sudo -u oxenfurt -E env PATH="/usr/local/bin:$PATH" DATABASE_URL="$DATABASE_URL" \
  /usr/local/bin/bun "${REL_DIR}/apps/backend/src/db/migrate.ts"

# Promote this release as current.
ln -sfn "${REL_DIR}" /opt/oxenfurt/current

# Start the backend.
systemctl enable --now oxenfurt-backend.service
sleep 2
systemctl status oxenfurt-backend --no-pager | head -12
```

### Verify

```bash
# Backend listening on loopback
ss -ltnp | grep ':3000' | grep -q '127.0.0.1' && echo "backend listening OK"

# /health returns 200 directly to backend
curl -fsS http://127.0.0.1:3000/health
# expected: {"ok":true}

# /api/health returns 200 through Caddy
curl -fsS "https://${DOMAIN}/api/health"
# expected: {"ok":true}

# Mini-app index reachable
curl -fsS "https://${DOMAIN}/" | head -5 | grep -qi '<html' && echo "mini-app OK"

# Migrations applied — expect tables present
sudo -u postgres psql -d oxenfurt -tAc "\dt" | grep -E '(cards|card_reviews|sessions)' \
  && echo "schema OK"
```

If `/api/health` returns 502, the backend hasn't started. Check:

```bash
journalctl -u oxenfurt-backend -n 50 --no-pager
```

Most common cause: missing/empty value in `/etc/oxenfurt/backend.env`.
The backend refuses to boot with helpful Valibot errors in the log.

---

## Stage 7 — Wire Hermes Agent

Reference: [`hermes/integration.md`](hermes/integration.md). What you do here:

### 7a. Discover how Hermes runs

```bash
HERMES_USER=$(systemctl show hermes-english -p User --value)
HERMES_GROUP=$(systemctl show hermes-english -p Group --value)
[ -z "$HERMES_USER" ] && HERMES_USER=root
[ -z "$HERMES_GROUP" ] && HERMES_GROUP=root
echo "Hermes runs as ${HERMES_USER}:${HERMES_GROUP}"

# Skill install path for that user
HERMES_HOME=$(getent passwd "$HERMES_USER" | cut -d: -f6)
SKILLS_DIR="${HERMES_HOME}/.hermes/skills"
echo "Skills go to: ${SKILLS_DIR}"
```

If `systemctl show hermes-english` returns nothing — Hermes isn't
installed under that service name. Ask the operator the actual service
name (`systemctl list-units 'hermes*' --type=service`), then re-export
`hermes-english` → the real name in subsequent commands.

### 7b. Create the shared env leaf

```bash
INGEST_TOKEN=$(grep '^INGEST_TOKEN=' /etc/oxenfurt/backend.env | cut -d= -f2-)

install -o root -g "${HERMES_GROUP}" -m 0640 /dev/stdin /etc/oxenfurt/hermes-shared.env <<EOF
OXENFURT_API_URL=http://127.0.0.1:3000
OXENFURT_INGEST_TOKEN=${INGEST_TOKEN}
EOF

stat -c '%a %U:%G' /etc/oxenfurt/hermes-shared.env
```

### 7c. Add the env file to hermes-english via a drop-in

```bash
mkdir -p /etc/systemd/system/hermes-english.service.d
cat > /etc/systemd/system/hermes-english.service.d/oxenfurt.conf <<'EOF'
[Service]
EnvironmentFile=/etc/oxenfurt/hermes-shared.env
EOF

systemctl daemon-reload
systemctl restart hermes-english

# Verify the variables are loaded
systemctl show hermes-english -p Environment | tr ' ' '\n' | grep OXENFURT
# expected: both OXENFURT_API_URL and OXENFURT_INGEST_TOKEN
```

### 7d. Install the skill

Try the idiomatic CLI first:

```bash
sudo -u "${HERMES_USER}" -H hermes -p english skills install \
  /root/oxenfurt-src/deploy/hermes/skills/oxenfurt_ingest.md
```

If the install command isn't available in this Hermes version, fall back
to placing the file directly:

```bash
install -d -o "${HERMES_USER}" -g "${HERMES_GROUP}" -m 0755 "${SKILLS_DIR}"
install -o "${HERMES_USER}" -g "${HERMES_GROUP}" -m 0644 \
  /root/oxenfurt-src/deploy/hermes/skills/oxenfurt_ingest.md \
  "${SKILLS_DIR}/oxenfurt_ingest.md"
systemctl restart hermes-english
```

Verify:

```bash
sudo -u "${HERMES_USER}" -H hermes -p english skills list 2>/dev/null \
  | grep -i oxenfurt \
  || ls "${SKILLS_DIR}/oxenfurt_ingest.md"
```

---

## Stage 8 — Steps that require a human in Telegram

You **cannot** do these — relay the instructions to the operator and
wait for confirmation before proceeding to Stage 9.

Send the operator this verbatim:

> Open a chat with `@BotFather` and run, for your existing english bot:
>
> 1. `/setdomain` → choose the bot → enter `DOMAIN_VALUE` (substitute the real domain).
> 2. `/newapp` (or `/editapp` if a Mini App already exists for this bot):
>    - title: `Oxenfurt`
>    - description: `Карточки английского из живых уроков`
>    - photo: upload a square icon (any image you like)
>    - web app URL: `https://DOMAIN_VALUE`
>    - short name: `oxenfurt`
> 3. Reply "done" once both `/setdomain` and the Mini App configuration are saved.

After the operator confirms, ask the bot privately: "open Oxenfurt"
or invoke the existing `/study` command — the Mini App should open and
land on the `Home` screen. If the bot still answers with the old menu,
the operator may need to `/restart` or wait 30 s for Telegram to refresh.

---

## Stage 9 — End-to-end smoke test

With everything wired:

```bash
source /root/oxenfurt-inputs.env

# 9a. Backend health
curl -fsS "https://${DOMAIN}/api/health" && echo

# 9b. Mini-app loads (look for any Vite-injected hash in the HTML)
curl -fsS "https://${DOMAIN}/" | grep -E 'src="/assets/.*\.js"' \
  | head -1 && echo "mini-app served OK"

# 9c. Hermes can reach the ingest endpoint with its token
INGEST_TOKEN=$(grep '^OXENFURT_INGEST_TOKEN=' /etc/oxenfurt/hermes-shared.env | cut -d= -f2-)
curl -fsS -X POST http://127.0.0.1:3000/ingest/cards \
  -H "Authorization: Bearer ${INGEST_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"cards":[{"type":"vocab","payload":{"term":"smoke-test","translation":"проверка","context_sentence":"This is a smoke-test sentence.","context_term_start":10,"context_term_end":20},"source":"agent-deploy"}]}'
# expected: {"created":1,"skipped":0}

# 9d. The card is in the DB
sudo -u postgres psql -d oxenfurt -tAc \
  "SELECT term FROM (SELECT payload->>'term' AS term FROM cards WHERE type='vocab') t WHERE term='smoke-test';"
# expected: smoke-test

# 9e. Clean up the smoke-test card
sudo -u postgres psql -d oxenfurt -c \
  "DELETE FROM cards WHERE type='vocab' AND payload->>'term'='smoke-test';"
```

If 9c returns 401, the `INGEST_TOKEN` in `backend.env` and
`hermes-shared.env` disagree. Re-run Stage 7b after fixing.

Now have the operator open the Mini App in Telegram and press **Начать
сессию**. With no cards, the empty state appears. Send a real transcript
to the english bot, confirm extraction, and the cards should arrive.
The operator pressing **Начать сессию** again should show them in the
due queue.

---

## Stage 10 — Verify the backup pipeline

```bash
# Run a backup now (don't wait for 03:00)
systemctl start oxenfurt-backup
journalctl -u oxenfurt-backup -n 20 --no-pager
ls -lh /opt/oxenfurt/backups/
# expected: oxenfurt-<timestamp>.sql.gz, non-empty
```

Confirm the timer is queued for the next run:

```bash
systemctl list-timers oxenfurt-backup.timer --no-pager
```

If `BACKUP_RCLONE_REMOTE` is set in `backend.env`, also verify the off-site
copy:

```bash
rclone ls "${BACKUP_RCLONE_REMOTE}" | tail -3
```

---

## Stage 11 — Cleanup + report

```bash
# Trim release directories — keep last 5
cd /opt/oxenfurt/releases && ls -1tr | head -n -5 | xargs -r rm -rf

# Remove the inputs file with secrets that's no longer needed
shred -u /root/oxenfurt-inputs.env

# Final summary
cat <<EOF
==> Deploy summary
Domain:           ${DOMAIN}
Backend:          $(systemctl is-active oxenfurt-backend)
Caddy:            $(systemctl is-active caddy)
Postgres:         $(systemctl is-active postgresql)
Hermes-english:   $(systemctl is-active hermes-english)
Backup timer:     $(systemctl is-active oxenfurt-backup.timer)
Current release:  $(readlink /opt/oxenfurt/current)
Mini-app dist:    $(ls /opt/oxenfurt/mini-app | wc -l) files
EOF
```

Report back to the operator with this block plus the URL of the Mini
App and any non-active service that needs attention.

---

## Future deploys (after the initial one)

For a code update from a new commit on the same repo:

```bash
cd /root/oxenfurt-src
git pull --ff-only

RELEASE="$(date -u +%Y%m%d-%H%M%S)"
REL_DIR="/opt/oxenfurt/releases/${RELEASE}"
install -d -o oxenfurt -g oxenfurt -m 0755 "${REL_DIR}"

rsync -a \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='.git/' \
  --exclude='*.tsbuildinfo' \
  /root/oxenfurt-src/ "${REL_DIR}/"
chown -R oxenfurt:oxenfurt "${REL_DIR}"
cd "${REL_DIR}"

sudo -u oxenfurt env PATH="/usr/local/bin:$PATH" \
  pnpm install --frozen-lockfile --filter=@oxenfurt/backend... --prod
sudo -u oxenfurt env PATH="/usr/local/bin:$PATH" \
  pnpm install --frozen-lockfile --filter=@oxenfurt/mini-app...
sudo -u oxenfurt env PATH="/usr/local/bin:$PATH" VITE_API_URL='' \
  pnpm --filter=@oxenfurt/mini-app build

# Only run migrations if drizzle/ has new files since last release.
if ! diff -rq \
    "$(readlink /opt/oxenfurt/current)/apps/backend/drizzle" \
    "${REL_DIR}/apps/backend/drizzle" >/dev/null 2>&1; then
  set -a; source /etc/oxenfurt/backend.env; set +a
  sudo -u oxenfurt -E env PATH="/usr/local/bin:$PATH" DATABASE_URL="$DATABASE_URL" \
    /usr/local/bin/bun "${REL_DIR}/apps/backend/src/db/migrate.ts"
fi

rsync -a --delete "${REL_DIR}/apps/mini-app/dist/" /opt/oxenfurt/mini-app/
chown -R oxenfurt:oxenfurt /opt/oxenfurt/mini-app

ln -sfn "${REL_DIR}" /opt/oxenfurt/current
systemctl restart oxenfurt-backend
sleep 2
curl -fsS "https://${DOMAIN}/api/health" && echo "deploy OK"

cd /opt/oxenfurt/releases && ls -1tr | head -n -5 | xargs -r rm -rf
```

For a rollback to the previous release:

```bash
cd /opt/oxenfurt/releases
CURRENT=$(readlink /opt/oxenfurt/current | xargs basename)
PREVIOUS=$(ls -1 | sort -r | grep -v "^${CURRENT}$" | head -1)
[ -z "$PREVIOUS" ] && { echo "no previous release"; exit 1; }
ln -sfn "/opt/oxenfurt/releases/${PREVIOUS}" /opt/oxenfurt/current
systemctl restart oxenfurt-backend
echo "rolled back to ${PREVIOUS}"
```

---

## Common errors and recovery

### `backend refuses to start`, log says `ENABLE_DEV_AUTH must not be true in NODE_ENV=production`

```bash
sed -i 's/^ENABLE_DEV_AUTH=.*/ENABLE_DEV_AUTH=false/' /etc/oxenfurt/backend.env
systemctl restart oxenfurt-backend
```

### `backend refuses to start`, log says `valibot.parse … expected ≥ 32 characters … received 0 characters`

A required env var is empty. Inspect `backend.env`:

```bash
awk -F= '/^[A-Z_]+=$/{print "EMPTY:", $1}' /etc/oxenfurt/backend.env
```

Fill in the missing values, restart.

### Caddy: `obtain: ACME challenge failed`

DNS is wrong, port 80 is blocked, or rate-limit from Let's Encrypt
(5 dupes/week). Verify:

```bash
dig +short A "$DOMAIN"   # must match the VPS public IP
ufw status | grep 80     # must show ALLOW
journalctl -u caddy --since '5 min ago' | grep -i 'rate'   # check for rate-limit
```

If rate-limited, point DNS to a staging server first or wait until the
week resets — there's no shortcut.

### `pnpm install` says `ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY`

The lockfile and `package.json` are out of sync. The operator must
re-generate the lockfile locally (`pnpm install` on their dev machine),
commit, and push. Until then the deploy can't continue.

### `/api/cards/due` returns 401 even after `/api/auth/session` succeeded

System clock drift. JWT is signed with `iat`/`exp` and Caddy/Bun
disagree on the moment.

```bash
timedatectl status
systemctl restart systemd-timesyncd   # if NTP isn't synced
```

### Hermes ingest gets 403

The Telegram user sending requests is not `OWNER_TELEGRAM_USER_ID`.
Hermes itself shouldn't hit `/auth/session` — it uses
`POST /ingest/cards` with the `INGEST_TOKEN`, no Telegram user check
involved there. If you're seeing 403 on `/ingest/cards`, that's a bug —
check the backend log for the exact path that returned 403.

### Backend dies with `unhandled rejection: Connection terminated unexpectedly`

Postgres restarted or `max_connections` hit. The systemd `Restart=on-failure`
will bring backend back; if it keeps cycling:

```bash
journalctl -u postgresql -n 50 --no-pager
sudo -u postgres psql -c "SHOW max_connections;"
sudo -u postgres psql -c "SELECT count(*) FROM pg_stat_activity;"
```

For a single-user system, defaults are fine; this points to a Postgres-side
issue, not application.

### Mini App in Telegram shows a stale build

Two possibilities:

1. Cache not invalidated. Verify Caddy is sending `no-cache` for
   `index.html`:

   ```bash
   curl -sI "https://${DOMAIN}/index.html" | grep -i cache
   ```

   Expected: `Cache-Control: no-cache, no-store, must-revalidate`.

2. Telegram's own WebView cache. Operator must close the Mini App
   completely, kill the Telegram process, and reopen.

### Backend can't reach Postgres: `connection refused 127.0.0.1:5432`

```bash
systemctl status postgresql
ss -ltnp | grep ':5432'     # expect listening on 127.0.0.1
sudo -u postgres psql -c "SELECT 1;"
```

If Postgres is listening on a Unix socket only (rare on Debian/Ubuntu
defaults), edit `/etc/postgresql/*/main/postgresql.conf` so that
`listen_addresses = 'localhost'`, then `systemctl restart postgresql`.

---

## Things you should NOT do

- Don't `chmod 0777` anything in `/etc/oxenfurt`. Those files are 0640
  for a reason.
- Don't disable ufw or open port 3000/5432 to the public.
- Don't set `NODE_ENV=development` on this VPS — that enables
  `/auth/dev-token` and CORS allow-anything if both flags are flipped
  together.
- Don't run `psql` as superuser against `oxenfurt` for routine work.
  Use the `oxenfurt` role: `psql -U oxenfurt -h 127.0.0.1 -d oxenfurt`.
- Don't `git pull` inside `/opt/oxenfurt/releases/*` — those are
  immutable. Pull in `/root/oxenfurt-src` then run the deploy block.
- Don't edit unit files in `/etc/systemd/system/hermes-english.service`
  directly. Always use `systemctl edit` for hermes-english to keep
  the operator's Hermes installer happy.

---

## Reference paths

| Path | Owned by | Mode | Purpose |
|------|----------|------|---------|
| `/root/oxenfurt-src` | root | 0700 | Working git checkout |
| `/opt/oxenfurt/releases/<ts>` | oxenfurt | 0755 | Immutable code per release |
| `/opt/oxenfurt/current` | symlink | — | Active release |
| `/opt/oxenfurt/mini-app` | oxenfurt | 0755 | Caddy doc-root for SPA |
| `/opt/oxenfurt/backups` | oxenfurt | 0750 | `pg_dump.gz` files |
| `/etc/oxenfurt/backend.env` | root:oxenfurt | 0640 | Backend secrets |
| `/etc/oxenfurt/hermes-shared.env` | root:hermes-group | 0640 | Token for Hermes |
| `/etc/oxenfurt/.pg_password` | root:oxenfurt | 0640 | Generated PG password |
| `/etc/caddy/Caddyfile` | root | 0644 | Reverse-proxy config |
| `/etc/systemd/system/oxenfurt-backend.service` | root | 0644 | Backend unit |
| `/etc/systemd/system/oxenfurt-backup.{service,timer}` | root | 0644 | Backup unit |
| `/etc/systemd/system/hermes-english.service.d/oxenfurt.conf` | root | 0644 | Drop-in adding our env file |

## Reference services

| Unit | What it does |
|------|--------------|
| `caddy.service` | Public-facing TLS + reverse proxy + static host |
| `postgresql.service` | Database |
| `oxenfurt-backend.service` | Bun + Hono API on 127.0.0.1:3000 |
| `oxenfurt-backup.service` (oneshot, fired by timer) | Nightly `pg_dump` |
| `oxenfurt-backup.timer` | Schedules backup at 03:00 + jitter |
| `hermes-english.service` | Operator's existing Hermes Agent gateway |
| `ufw.service` | Firewall |
