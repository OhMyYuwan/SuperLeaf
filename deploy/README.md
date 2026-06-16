# SuperLeaf Deploy

This folder is the user-facing deployment bundle. The default mode runs
SuperLeaf as one container that includes Nginx, the frontend, the FastAPI
backend, and the Yjs collab server. Nginx proxies to localhost inside that
container, so restricted Podman/Docker bridge networks do not block startup.

Local deployments expose one HTTP port; public deployments should use HTTPS
through either the bundled TLS override or an external reverse proxy.

## Start

```bash
./superleaf up
```

Open `http://localhost:8080` by default.

The gateway binds to `127.0.0.1` by default. To intentionally expose it on a
trusted LAN, set `SUPERLEAF_BIND_ADDR=0.0.0.0` in `.env` and review
registration, TLS, and firewall settings first.

For a campus server such as `172.28.7.26`, use:

```env
SUPERLEAF_BIND_ADDR=0.0.0.0
SUPERLEAF_HTTP_PORT=8080
YLW_PUBLIC_BASE_URL=http://172.28.7.26:8080
YLW_PUBLIC_REGISTRATION=false
```

Then open `http://172.28.7.26:8080/` from the campus network.

For servers whose Docker writable layer lives on a small or full disk, put
runtime scratch files on a large mounted filesystem before starting:

```env
SUPERLEAF_RUNTIME_DIR=/data2/superleaf-runtime
```

`SUPERLEAF_RUNTIME_DIR` is mounted into the all-in-one container for `/tmp`,
cache, logs, Nginx runtime files, and the frontend runtime config. This keeps
large LaTeX temporary files out of Docker's container overlay.

## HTTPS For Public Deployments

For public or multi-user deployments, use HTTPS and Secure session cookies.
Place certificate files at:

```text
deploy/certs/fullchain.pem
deploy/certs/privkey.pem
```

Then start the TLS gateway:

```bash
./superleaf tls-up
```

This uses `compose.tls.yml`, exposes HTTP 80 for redirects, exposes HTTPS 443,
and forces `YLW_COOKIE_SECURE=true` for backend session cookies. You can point
to different certificate paths in `.env`:

```env
SUPERLEAF_TLS_CERT_FILE=/absolute/path/fullchain.pem
SUPERLEAF_TLS_KEY_FILE=/absolute/path/privkey.pem
```

If you use Cloudflare, Caddy, Traefik, Nginx Proxy Manager, or another reverse
proxy for TLS, keep SuperLeaf bound to `127.0.0.1:8080` and make the proxy send
`X-Forwarded-Proto: https`. Leave `YLW_COOKIE_SECURE=auto`, or set it to
`true` for stricter public deployments.

If you do not have a domain yet, avoid exposing raw HTTP on the public
interface. For temporary server testing, prefer an SSH tunnel:

```bash
ssh -L 8080:127.0.0.1:8080 user@server
```

Public registration is disabled by default. `./superleaf up` creates `.env`
when needed and fills blank `YLW_BOOTSTRAP_TOKEN` and
`YLW_COLLAB_INTERNAL_TOKEN` values with random secrets. When a Bootstrap Token
is generated, the helper prints it once; enter that value on the registration
page to create the first admin account. Do not use a shared or checked-in token.

You can also prepare the environment without starting containers:

```bash
./superleaf init
```

After the first admin is created, open `/admin` from the account menu to
create one-time registration invitations. Keep `YLW_PUBLIC_REGISTRATION=false`
for campus or multi-user deployments. Set `YLW_PUBLIC_BASE_URL` to the public
HTTPS origin, for example `https://superleaf.example.edu`, so invite links in
emails point to the right server.

Email delivery is optional. If SMTP is not configured, `/admin` still shows a
copyable invite link/code. To send invitations by email, set:

```env
YLW_SMTP_HOST=smtp.example.edu
YLW_SMTP_PORT=587
YLW_SMTP_USERNAME=your-account
YLW_SMTP_PASSWORD=your-password
YLW_SMTP_FROM=SuperLeaf <no-reply@example.edu>
YLW_SMTP_TLS=true
```

Backend uses `YLW_COLLAB_INTERNAL_TOKEN` when reading Yjs document snapshots
from Collab Server, and Collab Server rejects `/docs/:docId/text` without this
internal token.

## Local Trusted MCP

Remote MCP is the safe default. For local debugging on your own machine or a
trusted single-user server, you can enable stdio MCP execution in `.env`:

```env
YLW_MCP_STDIO_ENABLED=true
```

Then start or restart backend:

```bash
./superleaf up
# or, if already running:
./superleaf restart backend
```

After the backend restarts, open Team Management -> MCP -> Custom MCP and use
the Local Trusted stdio tab. Keep this disabled for public registration,
multi-user, or untrusted deployments.

If you are testing with a local image archive before registry images are
published, load it before starting:

```bash
# Docker:
docker load -i images/superleaf-deploy-images.tar.gz

# Podman:
podman load -i images/superleaf-deploy-images.tar.gz
```

## Configure Images

The default `SUPERLEAF_IMAGE` is an all-in-one image:

```env
SUPERLEAF_IMAGE=ghcr.io/ohmyyuwan/superleaf:v0.1.0
```

A local image archive can provide that tag after `docker load` or
`podman load`, so `./superleaf up` works before the image is published to GHCR.

The previous multi-container topology is still available for normal Docker
Compose environments:

```bash
./superleaf multi-up
./superleaf multi-status
./superleaf multi-logs
```

Those commands use the advanced image variables:

```env
SUPERLEAF_BACKEND_IMAGE=ghcr.io/ohmyyuwan/superleaf-backend:v0.1.0
SUPERLEAF_FRONTEND_IMAGE=ghcr.io/ohmyyuwan/superleaf-frontend:v0.1.0
SUPERLEAF_COLLAB_IMAGE=ghcr.io/ohmyyuwan/superleaf-collab:v0.1.0
```

## Commands

```bash
./superleaf status
./superleaf logs
./superleaf logs app
./superleaf update
./superleaf backup
./superleaf restore backups/superleaf-backup-YYYYmmdd-HHMMSS.tar.gz
./superleaf down
```

Runtime data is stored under `data/`. Backups are written under `backups/`.

To migrate data from another machine, stop SuperLeaf on the source machine and
pack the deployment `.env` plus runtime data:

```bash
tar -czf superleaf-data.tar.gz -C /path/to/superleaf .env data
```

Copy `superleaf-data.tar.gz` to the server, extract it inside the deployment
directory, then start:

```bash
tar -xzf superleaf-data.tar.gz -C /opt/superleaf
cd /opt/superleaf
./superleaf up
```

## Package A Release Bundle

Maintainers can create a version-pinned deploy archive with:

```bash
./package.sh v0.1.0
```

The archive is written to `dist/superleaf-deploy-v0.1.0.tar.gz`.
