# Wiring Hermes Agent to Oxenfurt ingest

For the operator who already has a working **Hermes Agent**
(`hermes-agent.nousresearch.com`) on the same VPS with an `english` profile
(`hermes -p english gateway start`) and wants the agent to push extracted
vocab + theory cards into the practice database.

References: [Hermes Agent docs](https://hermes-agent.nousresearch.com/docs/)
· [CLI commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
· [Telegram messaging](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram)

## What the integration touches

| Piece                    | Where it lives                                            |
|--------------------------|-----------------------------------------------------------|
| `oxenfurt_ingest` skill  | `~/.hermes/skills/` (or profile-specific `$HERMES_HOME/skills/`) |
| `OXENFURT_API_URL`       | env passed to `hermes-english.service`                    |
| `OXENFURT_INGEST_TOKEN`  | env passed to `hermes-english.service`                    |

Hermes loads skills from `~/.hermes/skills/`. The two env vars are consumed
by the skill at call-time — Hermes itself doesn't care about them. The
recommended way to pass them in is a systemd drop-in (`systemctl edit`)
so the existing service file stays untouched.

## Step-by-step

### 1. Install the skill

The idiomatic way is the `hermes skills install` CLI, which copies the file
into the right place and registers it:

```sh
# As the user that owns the english profile (often `root` or `hermes`).
# If you're not sure which user runs hermes-english.service, check:
#   systemctl show hermes-english -p User -p ExecStart

sudo -u <hermes-user> hermes -p english skills install \
  /tmp/oxenfurt-deploy/hermes/skills/oxenfurt_ingest.md
```

Verify:

```sh
sudo -u <hermes-user> hermes -p english skills list | grep oxenfurt
```

If you prefer the manual route — works the same in practice:

```sh
sudo install -o <hermes-user> -g <hermes-user> -m 0644 \
  /tmp/oxenfurt-deploy/hermes/skills/oxenfurt_ingest.md \
  ~<hermes-user>/.hermes/skills/oxenfurt_ingest.md
```

(Replace `~<hermes-user>` with the actual path, e.g. `/root/.hermes/skills/`
or `/home/hermes/.hermes/skills/`.)

### 2. Install the shared env leaf

```sh
sudo cp /tmp/oxenfurt-deploy/env/hermes-shared.env.example \
        /etc/oxenfurt/hermes-shared.env
sudo editor /etc/oxenfurt/hermes-shared.env
# Paste OXENFURT_INGEST_TOKEN — the same value as in /etc/oxenfurt/backend.env.
```

Lock it down so only the hermes service user can read it. Find the group:

```sh
systemctl show hermes-english -p Group
# Example output: Group=root  (or whatever the installer used)
```

Then:

```sh
sudo chown root:<hermes-group> /etc/oxenfurt/hermes-shared.env
sudo chmod 0640 /etc/oxenfurt/hermes-shared.env
```

If `hermes-english.service` runs as `root` (typical for `hermes gateway
start`-generated units), `root:root 0600` is enough.

### 3. Attach the env file to the service (drop-in override)

Don't edit `/etc/systemd/system/hermes-english.service` directly — the
Hermes installer may regenerate it on update. Use a drop-in:

```sh
sudo systemctl edit hermes-english.service
```

In the editor add:

```ini
[Service]
EnvironmentFile=/etc/oxenfurt/hermes-shared.env
```

systemd writes
`/etc/systemd/system/hermes-english.service.d/override.conf` with that
snippet. Reload + restart:

```sh
sudo systemctl daemon-reload
sudo systemctl restart hermes-english
```

Verify the variables made it into the unit:

```sh
sudo systemctl show hermes-english -p Environment | tr ' ' '\n' | grep OXENFURT
```

You should see both `OXENFURT_API_URL` and `OXENFURT_INGEST_TOKEN`.

### 4. Smoke test

From a Telegram chat with the english profile bot, send a transcript and
confirm extraction. Then watch the backend logs:

```sh
sudo journalctl -u oxenfurt-backend -f
```

You should see `POST /ingest/cards 200` entries. Open the Mini App and
verify vocab cards appear in the due queue and theory cards in the
draft-review screen.

## Rotation

When you rotate `INGEST_TOKEN`:

1. New value in `/etc/oxenfurt/backend.env` (key: `INGEST_TOKEN`).
2. Same value in `/etc/oxenfurt/hermes-shared.env`
   (key: `OXENFURT_INGEST_TOKEN`).
3. Restart both: `sudo systemctl restart oxenfurt-backend hermes-english`.

Both services pick up the new value at the same moment.

## Troubleshooting

### `401 unauthorized` in backend logs after Hermes posts

Token mismatch. Confirm both files contain the same value:

```sh
sudo grep -h INGEST_TOKEN /etc/oxenfurt/backend.env \
                          /etc/oxenfurt/hermes-shared.env
```

### Hermes can't reach `127.0.0.1:3000`

Either Hermes runs in a network namespace that doesn't share loopback
with the host (rare on a plain VPS install), or the backend isn't
listening. Check:

```sh
sudo ss -ltnp | grep :3000
```

Expect `127.0.0.1:3000` owned by `bun`. If you see `0.0.0.0:3000` review
`apps/backend/src/index.ts` — bind is meant to stay on loopback.

### Skill never fires

Hermes only triggers the ingest skill **after** transcript analysis AND
the learner's explicit confirmation. Re-read
[`skills/oxenfurt_ingest.md`](skills/oxenfurt_ingest.md) — there's an
explicit "do not offer proactively" rule. Send a transcript, follow up
with "save these" in the chat, then check logs.

To double-check the skill is loaded:

```sh
sudo -u <hermes-user> hermes -p english skills list
```

`oxenfurt_ingest` should appear in the listing.

### Hermes Agent itself isn't installed yet

If you don't already have `hermes-english.service`, install Hermes first
per the [official getting-started guide](https://hermes-agent.nousresearch.com/docs/),
then come back here. The Telegram bot for the `english` profile should
be set up before you wire Oxenfurt to it. The Oxenfurt deploy doesn't
install or manage Hermes itself — that's the user's existing setup.

## Adding a scope (a second agent, e.g. `go`)

Scopes are declared in the backend env, not created in the app. One
scope = one Hermes profile = one deck of cards. The Mini App grows a
scope switcher the moment there are two.

### 1. Declare the scope and its token

Edit `/etc/oxenfurt/backend.env`:

```ini
# First entry stays the default scope and owns INGEST_TOKEN.
SCOPES=english:English:🇬🇧:indigo,go:Go:🐹:emerald
INGEST_TOKENS=go=<openssl rand -hex 32>
```

Accent keys: `indigo`, `emerald`, `amber`, `rose`, `sky`, `violet`.
Slug rules: lowercase letters/digits/hyphens, ≤ 32 chars.

### 2. Restart the backend, then check the list

```sh
sudo systemctl restart oxenfurt-backend
sudo journalctl -u oxenfurt-backend -n 5 | grep listening
# → oxenfurt-backend listening on 127.0.0.1:3000 (scopes: english, go)
```

The `scopes` table is upserted at boot; the migration that created it
(`0007_scopes.sql`) backfilled every pre-existing row into `english`,
so existing data is untouched.

### 3. Wire the new Hermes profile

Install the same skills into the new profile and give it its own env
leaf:

```sh
sudo -u <hermes-user> hermes -p go skills install \
  /tmp/oxenfurt-deploy/hermes/skills/oxenfurt_ingest.md
# …same for oxenfurt_assignments.md and oxenfurt_answer_questions.md

printf 'OXENFURT_API_URL=http://127.0.0.1:3000\nOXENFURT_INGEST_TOKEN=<the go=... token>\n' \
  | sudo tee /etc/oxenfurt/hermes-go.env >/dev/null
sudo chown root:<hermes-group> /etc/oxenfurt/hermes-go.env
sudo chmod 0640 /etc/oxenfurt/hermes-go.env

sudo systemctl edit hermes-go.service
# [Service]
# EnvironmentFile=/etc/oxenfurt/hermes-go.env
sudo systemctl daemon-reload && sudo systemctl restart hermes-go
```

### 4. Smoke test

Send a transcript to the new profile's bot and confirm:

```sh
sudo journalctl -u oxenfurt-backend -f   # → POST /ingest/cards 200
```

Open the Mini App — the scope pills appear under the header, and the
new scope shows its own empty deck until the agent posts cards.

### What isolation means here

- The `go` agent's token resolves to the `go` scope on every request —
  it cannot ingest, assign, answer or even *see* `english` cards,
  questions or diagnostics. Prompt injection cannot cross the deck
  boundary because there is no route for it.
- Assignment slots, card dedup (the same term in two scopes is two
  cards), streaks, heatmaps and stats are all per-scope.
- The Mini App stays a single entry point: switching a pill switches
  the whole context (assignment, queue, stats, accent color).
