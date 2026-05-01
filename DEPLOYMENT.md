# regenhub.xyz Deployment Guide

> For humans and agents managing the RegenHub stack on local infrastructure.

## Overview

The regenhub.xyz stack is self-hosted on RegenHub's local compute cluster and exposed publicly via Cloudflare Tunnels. No cloud provider — everything runs at the space.

**Domains:**
- `regenhub.xyz` → Next.js web app (production, via Cloudflare Tunnel)
- `site.regenhub.build` → same app, internal hostname (also works)
- `supabasekong-w8gw0wc80o80c0c8g88kk8og.regenhub.build` → Supabase API (Kong gateway)

**Repo:** `https://github.com/RegenHub-Boulder/regenhub.xyz`  
**Structure:** pnpm monorepo — `apps/web` (Next.js 15), `apps/bot` (Telegram bot), `supabase/migrations/`

---

## Infrastructure

### Machines

| Host | IP | Role |
|------|----|------|
| `regenhub-compute-1.lan` | 192.168.1.200 | Compute: Docker, Coolify, all services |
| `regenhub-compute-2.lan` | 192.168.1.201 | Agent host (OpenClaw runs here) |

Both machines must be on the RegenHub LAN (`192.168.1.x`). Compute-2 can SSH into compute-1 via `steward@regenhub-compute-1.lan` using an ed25519 key.

### Access Required

To manage deployments, you need:
- **Coolify API key** — stored in `~/.openclaw/secrets/credentials.json` → `coolify.apiKey`
- **Coolify base URL** — `http://regenhub-compute-1.lan:8000` (LAN only) or `https://admin.regenhub.build` (public)
- **Cloudflare API token** — `credentials.json` → `cloudflare.apiToken` (zone: `regenhub.build`)
- **SSH access** — `steward@regenhub-compute-1.lan` from compute-2 (ed25519 key pre-configured)
- **GitHub token** — `credentials.json` → `github.token` (regenclaw account, write access to repo)

### Key IDs

| Resource | ID/UUID |
|----------|---------|
| Coolify web app | `ew848c4os44sw0wowwk0ksk8` |
| Coolify bot app | `t84sosw40088kokwco80kksw` |
| Supabase instance | `w8gw0wc80o80c0c8g88kk8og` |
| Cloudflare zone (`regenhub.build`) | `01424a7ad7c85fcfef84033ca540da79` |
| Cloudflare account | `e94c43925ef19151277047a39e65f22d` |
| Site tunnel ID | `9afe98a9-34e0-4e56-835a-a59b31f9a61e` |

---

## Supabase (Self-Hosted)

Supabase runs as ~14 Docker containers on compute-1, managed by Coolify. The Kong gateway is the public entry point.

**Public URL:** `https://supabasekong-w8gw0wc80o80c0c8g88kk8og.regenhub.build`

### Check container health
```bash
ssh steward@regenhub-compute-1.lan \
  "sudo docker ps --filter 'name=supabase-*-w8gw0wc80o80c0c8g88kk8og' --format 'table {{.Names}}\t{{.Status}}'"
```

### Run migrations
Migrations live in `supabase/migrations/`. To apply:
```bash
# From compute-2 (has LAN access)
PGPASSWORD=<db-password> psql \
  -h 192.168.1.200 -p <exposed-port> \
  -U postgres -d postgres \
  -f supabase/migrations/001_initial_schema.sql
```

Or via the Supabase Studio UI at `https://supabase-studio-w8gw0wc80o80c0c8g88kk8og.regenhub.build`.

### Get credentials from running container
```bash
ssh steward@regenhub-compute-1.lan \
  "sudo docker inspect supabase-studio-w8gw0wc80o80c0c8g88kk8og \
   -f '{{range .Config.Env}}{{println .}}{{end}}'" | grep -E "ANON_KEY|SERVICE_ROLE|POSTGRES_PASSWORD"
```

### Configure SMTP (email)
Set these env vars on the Supabase auth container in Coolify (`supabase-auth-w8gw0wc80o80c0c8g88kk8og`):
```
GOTRUE_SMTP_HOST=smtp.resend.com
GOTRUE_SMTP_PORT=587
GOTRUE_SMTP_USER=resend
GOTRUE_SMTP_PASS=<resend-api-key>
GOTRUE_SMTP_ADMIN_EMAIL=noreply@regenhub.xyz
GOTRUE_SMTP_SENDER_NAME=RegenHub
```
Recommended provider: [Resend](https://resend.com) — 3,000 free emails/month. Verify the sending domain in the Resend dashboard and add the DNS TXT record to the `regenhub.xyz` Cloudflare zone.

---

## Backups & Recovery

> **Status (2026-05-01):** No automated backups exist. The Apr 27 incident (#38) recovered cleanly only because the Docker volumes survived a host reboot. If a volume is lost — disk failure, accidental `docker volume rm`, a botched `docker compose down -v` — there is currently no way to recover the data. Setting up a weekly `pg_dump` to an off-host location is the single highest-leverage operational win for this stack and is recommended below.

### What holds state

The Supabase instance ID is `w8gw0wc80o80c0c8g88kk8og` (used as a suffix on every container and volume name). The stack runs ~14 containers but only a handful hold persistent data:

| Volume | What's in it | Recovery cost if lost |
|---|---|---|
| `w8gw0wc80o80c0c8g88kk8og_supabase-db-data` | Postgres data directory (members, day codes, applications, free-day claims, access logs, auth users) | **Total** — every member record, every code ever issued, every login. No way to rebuild without a backup. |
| `w8gw0wc80o80c0c8g88kk8og_supabase-db-config` | Postgres config (`postgresql.conf`, `pg_hba.conf`) | Low — recreatable from the Supabase image defaults. |
| `w8gw0wc80o80c0c8g88kk8og_supabase-storage` | Supabase Storage bucket files | Currently unused — `members.profile_photo_url` is a free-text URL column, no uploads land in Storage. Safe to ignore for now; revisit when uploads are added. |
| `/data/coolify/services/w8gw0wc80o80c0c8g88kk8og/.env` | Service env (anon key, service-role key, JWT secret, Postgres password, etc.) | High — without these, the surviving DB is unreachable. Coolify's DB is the source of truth, but env drift between Coolify and this on-disk file caused the Kong-key half of #38. |
| `/data/coolify/services/w8gw0wc80o80c0c8g88kk8og/docker-compose.yaml` | Generated compose file | Low — Coolify regenerates it. |

List the live volumes:
```bash
ssh steward@regenhub-compute-1.lan \
  "sudo docker volume ls --filter name=w8gw0wc80o80c0c8g88kk8og"
```

### Recommended backup strategy

Until something better is in place, do **at least** one of these. (A) is highest-leverage and cheapest:

**(A) Weekly `pg_dump` to off-host storage.** A logical dump is portable across Postgres versions, small (~tens of MB compressed for this dataset), and restores cleanly into a fresh container. Suggested cadence: weekly via cron on compute-1, retain the last 8 dumps.

```bash
# Example cron entry on compute-1 (steward crontab):
# Sunday 03:00 — dump, gzip, push off-host, prune local copies
0 3 * * 0 /home/steward/backup-supabase.sh
```

The script (sketch — needs to be written and tested):
```bash
#!/usr/bin/env bash
set -euo pipefail
INSTANCE=w8gw0wc80o80c0c8g88kk8og
TS=$(date +%Y%m%d-%H%M%S)
OUT=/var/backups/supabase/${INSTANCE}-${TS}.sql.gz
mkdir -p /var/backups/supabase
sudo docker exec supabase-db-${INSTANCE} \
  pg_dump -U supabase_admin -d postgres --no-owner --clean --if-exists \
  | gzip > "$OUT"
# Off-host: rsync to a separate box, S3-compatible bucket, or compute-2
rsync -a "$OUT" steward@regenhub-compute-2.lan:/srv/backups/supabase/
# Prune: keep last 8 weekly dumps locally
ls -1t /var/backups/supabase/*.sql.gz | tail -n +9 | xargs -r rm
```

**(B) Volume snapshots.** Lower priority than (A) — `docker run --rm -v <vol>:/v -v $(pwd):/out alpine tar czf /out/<vol>-<ts>.tar.gz -C /v .` produces a tarball of the raw data directory. Restore is `tar xzf` into a fresh empty volume. Snapshot from a stopped or pause-and-checkpoint Postgres for consistency, or accept a slightly inconsistent snapshot and hope the WAL replays cleanly. `pg_dump` is more robust.

**(C) Off-site copy.** Whatever path you pick for (A) or (B), a copy should leave the building. Compute-2 on the same LAN survives compute-1 failure but not site-wide events (fire, theft, internet loss). A weekly push to S3 / B2 / a remote VPS via `rclone` or `restic` is the gold standard.

### Verifying a backup actually restores

A backup that hasn't been restored is a hope, not a backup. Once a dump cadence is in place, restore the latest dump into a throwaway Postgres container and confirm the row counts match prod, at least quarterly:

```bash
# On any Linux box with Docker
gunzip -c <dump>.sql.gz | docker exec -i <test-pg-container> psql -U postgres -d test_restore
docker exec <test-pg-container> psql -U postgres -d test_restore -c "SELECT count(*) FROM members;"
```

### Recovery: DB container missing, volumes survive

This is the failure mode hit on 2026-04-27 (#38). The host rebooted, every Supabase service came back **except** `supabase-db-w8gw0wc80o80c0c8g88kk8og`, which was missing entirely from `docker ps -a`. Auth/storage/supavisor crash-looped trying to reach a database that wasn't there.

The trap: don't use Coolify's UI "Start" or "Redeploy" — those regenerate `SERVICE_PASSWORD_*` values, and the existing data volume's password won't match. Instead, recreate **only the db service** using the existing compose file and on-disk env:

```bash
ssh steward@regenhub-compute-1.lan
cd /data/coolify/services/w8gw0wc80o80c0c8g88kk8og
sudo docker compose up -d --no-deps supabase-db
```

`--no-deps` is the important flag — it stops compose from also touching `supabase-auth`, `supabase-kong`, etc. The auth/storage/supavisor/analytics containers that were crash-looping will reconnect within ~30 seconds once Postgres is reachable.

Verify:
```bash
sudo docker ps --filter name=supabase-db-w8gw0wc80o80c0c8g88kk8og
sudo docker exec supabase-db-w8gw0wc80o80c0c8g88kk8og pg_isready -U supabase_admin
```

If a migration was pending when the outage hit, apply it directly with `psql` (Studio UI may also be unreachable until Kong recovers — see next section):
```bash
sudo docker exec supabase-db-w8gw0wc80o80c0c8g88kk8og \
  psql -U supabase_admin -d postgres -f - < supabase/migrations/0XX_whatever.sql
```

### Recovery: Kong consumer keys stale (`Invalid authentication credentials`)

Symptom: every API call from the web app gets `401 Invalid authentication credentials` even though the anon key in `apps/web/.env.production` is the same one that worked yesterday.

Cause: Kong's `kong.yml` substitutes `$SUPABASE_ANON_KEY` and `$SUPABASE_SERVICE_KEY` from `/data/coolify/services/<id>/.env` at container startup. These env values can drift from the live `JWT_SECRET` used by auth/postgrest/db — usually because Coolify regenerated them but the JWT secret wasn't rotated in lockstep. Web's anon key (signed with the live secret) is correct; Kong's stored copy (signed with an older secret) is stale → Kong rejects everything.

**Verify which key is stale.** For each candidate JWT, recompute the signature against the live `JWT_SECRET` (read from the running auth container env) and compare to the JWT's signature segment:

```bash
# Get live JWT_SECRET
ssh steward@regenhub-compute-1.lan \
  "sudo docker inspect supabase-auth-w8gw0wc80o80c0c8g88kk8og \
   --format '{{range .Config.Env}}{{println .}}{{end}}'" \
  | grep '^GOTRUE_JWT_SECRET=' | cut -d= -f2-

# Recompute signature for a candidate JWT (header.payload portion)
HP='eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzdXBhYmFzZSIsImlhdCI6...'
SECRET='<the JWT_SECRET above>'
printf '%s' "$HP" | openssl dgst -sha256 -hmac "$SECRET" -binary \
  | openssl base64 -A | tr -d '=' | tr '/+' '_-'
```

Compare to the JWT's third segment (everything after the final dot). Match = good; mismatch = stale.

**Fix.** Patch the stale key(s) in `.env` and restart only Kong:

```bash
ssh steward@regenhub-compute-1.lan
cd /data/coolify/services/w8gw0wc80o80c0c8g88kk8og
sudo cp .env .env.bak.$(date +%s)
# Edit: set SERVICE_SUPABASEANON_KEY and/or SERVICE_SUPABASESERVICE_KEY
# to JWTs that verify against the live JWT_SECRET. The web app's
# NEXT_PUBLIC_SUPABASE_ANON_KEY (in apps/web/.env.production) is the
# canonical anon key.
sudo nano .env
sudo docker compose up -d --no-deps supabase-kong
```

Smoke-test:
```bash
ANON='<the now-correct anon key>'
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  https://supabasekong-w8gw0wc80o80c0c8g88kk8og.regenhub.build/auth/v1/settings
# Expect: 200
```

**Make it durable.** The `.env` patch lives only on disk — Coolify's UI/DB is the source of truth and a future Coolify-driven service redeploy will overwrite the file. Update the same env vars in the Coolify UI for the `regenhub-supabase` service so the next redeploy doesn't reintroduce stale keys.

### Recovery: total volume loss (the one we don't have a story for)

If the Postgres data volume is destroyed and there's no backup, the data is gone. Members would need to re-register, applications re-submit, day-pass balances re-credit by hand against payment-receipt records. Avoid by implementing the backup strategy above; this entry exists to make the consequence visible, not because there's a procedure.

If a backup exists, restore looks like:

```bash
# 1. Stop dependents so nothing writes during restore
sudo docker compose stop supabase-auth supabase-rest supabase-storage supabase-supavisor supabase-realtime

# 2. Drop the broken volume and let compose recreate it empty
sudo docker compose rm -f supabase-db
sudo docker volume rm w8gw0wc80o80c0c8g88kk8og_supabase-db-data
sudo docker compose up -d --no-deps supabase-db

# 3. Wait until Postgres is ready, then load the dump
sudo docker exec -i supabase-db-w8gw0wc80o80c0c8g88kk8og \
  psql -U supabase_admin -d postgres < <(gunzip -c /path/to/dump.sql.gz)

# 4. Bring everything else back
sudo docker compose up -d
```

Test this path against a non-prod instance before you need it for real.

---

## Web App (Next.js)

Deployed via Coolify as a Dockerfile build (not Nixpacks).

### Monorepo structure note
This is a pnpm monorepo. Next.js `output: "standalone"` nests the output under the monorepo path:
- `server.js` → `apps/web/apps/web/server.js` (double-nested)
- Static assets → `apps/web/apps/web/.next/static/`

The `apps/web/Dockerfile` handles this correctly — don't change the `CMD` or `COPY` paths without checking.

### Environment variables
`NEXT_PUBLIC_*` variables are **baked at build time**. Changing them requires a rebuild+redeploy.

| Variable | Value |
|----------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://supabasekong-w8gw0wc80o80c0c8g88kk8og.regenhub.build` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Get from Supabase container (see above) |

### Deploy / Redeploy
```bash
COOLIFY_TOKEN="<from credentials.json>"
COOLIFY_URL="https://admin.regenhub.build"
APP_ID="ew848c4os44sw0wowwk0ksk8"

# Trigger rebuild + deploy
curl -X GET "$COOLIFY_URL/api/v1/deploy?uuid=$APP_ID&force=true" \
  -H "Authorization: Bearer $COOLIFY_TOKEN"
```

### Watch deployment logs
```bash
DEP_UUID="<deployment_uuid from above response>"
curl "$COOLIFY_URL/api/v1/deployments/$DEP_UUID" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" | jq '.status'
```

### GitHub autodeploy
To trigger deploys on push, add a GitHub webhook to the repo:
- **Payload URL:** `https://admin.regenhub.build/webhooks/deploy/<webhook-secret>`
- **Content type:** `application/json`
- **Events:** Just the push event

Get the webhook URL from Coolify UI → app → Webhooks tab.

---

## Networking: Cloudflare Tunnels + Traefik

### How it works
```
Browser → Cloudflare Edge → Cloudflare Tunnel (cloudflared on compute-1)
  → Traefik (port 80/443 on compute-1)
  → Docker container (via static route or Docker label)
```

### Known issue: Traefik + Docker Engine 29.2
Docker Engine 29.2 raised the minimum API version to 1.44. Traefik v3.1 requests v1.24 — **Docker-based service discovery is broken** for new containers. Existing containers still work.

**Workaround:** Write a static Traefik route file:
```bash
ssh steward@regenhub-compute-1.lan "sudo tee /data/coolify/proxy/dynamic/<appname>.yaml" << 'EOF'
http:
  routers:
    myapp-https:
      rule: "Host(`myapp.regenhub.build`)"
      entryPoints: [https]
      service: myapp
      tls:
        certResolver: letsencrypt
    myapp-http:
      rule: "Host(`myapp.regenhub.build`)"
      entryPoints: [http]
      service: myapp
  services:
    myapp:
      loadBalancer:
        servers:
          - url: "http://<container-docker-ip>:<port>"
EOF
```

Get the container's Docker network IP:
```bash
ssh steward@regenhub-compute-1.lan \
  "sudo docker inspect <container-name> --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'"
```

Traefik watches `/data/coolify/proxy/dynamic/` and picks up changes live — no restart needed.

### Add a new tunnel
```bash
ssh steward@regenhub-compute-1.lan "sudo /opt/shipper/tunnel.sh create <name> <local-port>"
# Creates: https://<name>.regenhub.build → localhost:<local-port>
```

If the service doesn't have a host port (Docker-only network), either:
1. Add a static Traefik route (route to Docker network IP) + point tunnel to port 80 (Traefik)
2. Use `socat` to forward a localhost port to the Docker network IP

### Add hostname to existing tunnel
To route a new hostname through the same tunnel as `site.regenhub.build`:
1. Add a DNS CNAME in Cloudflare → `48f43c33-153d-4105-aa0e-f214f8c58961.cfargotunnel.com` (proxied)
2. Update the tunnel ingress config via CF API to include the new hostname
3. Restart the tunnel service: `sudo systemctl restart shipper-tunnel-site.service`
4. Add a Traefik static route for the new hostname

### List active tunnels
```bash
ssh steward@regenhub-compute-1.lan "sudo /opt/shipper/tunnel.sh list"
```

---

## Telegram Bot

The bot (`apps/bot`) is **Coolify-managed** since 2026-04-28 (migrated off bare-metal `docker run`). It runs as a normal Coolify application alongside the web app, with env vars stored durably in Coolify's DB.

**Coolify app UUID:** `t84sosw40088kokwco80kksw` (`regenhub-bot`, build_pack: dockerfile, dockerfile: `/apps/bot/Dockerfile`, port: 3000)

### Redeploy / rebuild

```bash
COOLIFY_TOKEN="<from credentials.json>"
curl -X GET "http://192.168.1.200:8000/api/v1/deploy?uuid=t84sosw40088kokwco80kksw&force=true" \
  -H "Authorization: Bearer $COOLIFY_TOKEN"
```

Or via the Coolify UI — same workflow as the web app. Deploys take ~45s (Dockerfile build).

### Health check

The bot exposes `GET /health` on port 3000 returning `200 {"ok":true,"ts":...}`. Used by Coolify/Traefik to consider the container healthy. The actual bot work (Telegram polling, scheduler) runs in parallel — `/health` doesn't represent Telegram connectivity, just process liveness.

### Required env vars (set in Coolify UI for `t84sosw40088kokwco80kksw`)

| Variable | Source / Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather → `/mybots` → API Token |
| `SUPABASE_URL` | `https://supabasekong-w8gw0wc80o80c0c8g88kk8og.regenhub.build` |
| `SUPABASE_SERVICE_ROLE_KEY` | From running Supabase auth container env (`SERVICE_PASSWORD_JWT`-signed JWT for `service_role`) |
| `HA_URL` | `http://192.168.1.141:8123/api` (direct IP — `homeassistant.lan` does not resolve) |
| `HA_TOKEN` | Long-lived HA access token |
| `HA_LOCK_ENTITIES` | `lock.front_door_lock,lock.back_door_lock` |
| `TIMEZONE` | `America/Denver` |
| `HEALTH_PORT` | `3000` (default; only set to override) |

Get `SUPABASE_SERVICE_ROLE_KEY` from the running Supabase container if needed:
```bash
sudo docker inspect supabase-analytics-w8gw0wc80o80c0c8g88kk8og \
  --format '{{range .Config.Env}}{{println .}}{{end}}' | grep SERVICE_ROLE
```
Verify the JWT signature matches the live `JWT_SECRET` (see #38 appendix) — Kong will reject keys signed with a stale secret.

### Legacy bare-metal fallback (deprecated)

A `rebuild-bot.sh` script exists at `/home/steward/rebuild-bot.sh` on compute-1 from the bare-metal era. It is **deprecated** and should not be used in normal operation — Coolify is now the source of truth. Kept on disk only as an emergency fallback if Coolify itself is unhealthy and the bot needs to come back up via a hand-rolled `docker run`.

---

## Common Operations

### Check what's running
```bash
ssh steward@regenhub-compute-1.lan "sudo docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -v supabase"
```

### View app logs
```bash
ssh steward@regenhub-compute-1.lan "sudo docker logs ew848c4os44sw0wowwk0ksk8-<suffix> --tail 50"
# Get current container name first:
ssh steward@regenhub-compute-1.lan "sudo docker ps --format '{{.Names}}' | grep ew848c"
```

### Access Coolify dashboard
- Local: `http://regenhub-compute-1.lan:8000`
- Public: `https://admin.regenhub.build`

### Access Supabase Studio
- `https://supabase-studio-w8gw0wc80o80c0c8g88kk8og.regenhub.build`

---

## DNS Flip (regenhub.xyz → site.regenhub.build)

The `regenhub.xyz` domain is managed in a separate Cloudflare account (not the `regenhub.build` account). Whoever controls that zone needs to:

1. Change the A records from GitHub Pages IPs (`185.199.x.x`) to Cloudflare Tunnel:
   - Remove existing A records for `@` and `www`
   - Add CNAME: `@` → `48f43c33-153d-4105-aa0e-f214f8c58961.cfargotunnel.com` (proxied)
   - Add CNAME: `www` → same
2. Update tunnel ingress to accept `regenhub.xyz` and `www.regenhub.xyz`
3. Add Traefik static routes for both hostnames

---

*Last updated: 2026-03-11*

---

## Post-Deploy Route Update (automated)

Every Coolify redeploy creates a new container with a new Docker IP. A post-deploy hook handles this automatically.

**Script:** `/opt/shipper/update-route.sh` on compute-1  
**Coolify config:** set as `post_deployment_command` on the web app (already configured)

To set it up on a new app:
```bash
# 1. Script usage
ssh steward@regenhub-compute-1.lan "sudo /opt/shipper/update-route.sh <coolify-name-label> <route-file.yaml> <port>"

# 2. Register with Coolify
curl -X PATCH "$COOLIFY_URL/api/v1/applications/<app-uuid>" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"post_deployment_command": "sudo /opt/shipper/update-route.sh <name> <route.yaml> <port>", "post_deployment_command_container": "host"}'
```

**Note on Traefik + Docker Engine 29.2:** Docker's label-based auto-discovery is broken (Traefik v3.x sends API v1.24, Docker 29.2 requires min v1.44). The fix requires upgrading Docker Engine to a version with a lower minimum, or waiting for Coolify to ship a Traefik version that negotiates API version correctly. Until then, static route files + the update script are the workaround.
