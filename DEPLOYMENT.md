# regenhub.xyz Deployment Guide

> For humans and agents managing the RegenHub stack on local infrastructure.

## Overview

The regenhub.xyz stack is self-hosted on RegenHub's local compute cluster and exposed publicly via Cloudflare Tunnels. No cloud provider — everything runs at the space.

**Domains:**
- `site.regenhub.build` → Next.js web app (live, internal)
- `regenhub.xyz` → DNS not yet flipped (still GitHub Pages) — needs Cloudflare zone access
- `supabasekong-w8gw0wc80o80c0c8g88kk8og.regenhub.build` → Supabase API (Kong gateway)

**Repo:** `https://github.com/RegenHub-Boulder/regenhub.xyz`  
**Structure:** pnpm monorepo — `apps/web` (Next.js 15), `apps/bot` (Telegram bot), `supabase/migrations/`

---

## Infrastructure

### Machines

| Host | IP | Role |
|------|----|------|
| `regenhub-compute-1.lan` | 192.168.1.228 | Compute: Docker, Coolify, all services |
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
| Supabase instance | `w8gw0wc80o80c0c8g88kk8og` |
| Cloudflare zone (`regenhub.build`) | `01424a7ad7c85fcfef84033ca540da79` |
| Cloudflare account | `e94c43925ef19151277047a39e65f22d` |
| Site tunnel ID | `48f43c33-153d-4105-aa0e-f214f8c58961` |

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
  -h 192.168.1.228 -p <exposed-port> \
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

The bot (`apps/bot`) runs as a standalone Docker container on compute-1.

**Status:** Not yet deployed — waiting on `TELEGRAM_BOT_TOKEN` and `HA_TOKEN` from Aaron.

When ready:
```bash
# On compute-1
sudo docker run -d \
  --name regenhub-bot \
  --network host \
  --restart unless-stopped \
  -e SUPABASE_URL=https://supabasekong-w8gw0wc80o80c0c8g88kk8og.regenhub.build \
  -e SUPABASE_SERVICE_ROLE_KEY=<from-supabase-container> \
  -e TELEGRAM_BOT_TOKEN=<from-aaron> \
  -e HA_URL=http://homeassistant.lan:8123/api \
  -e HA_TOKEN=<from-aaron> \
  regenhub-bot:latest
```

Build image first: `docker build -f apps/bot/Dockerfile -t regenhub-bot .` from repo root.

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

*Last updated: 2026-03-01 by RegenClaw 🍄*

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
