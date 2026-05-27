# SuperLeaf Deploy

This folder is the user-facing deployment bundle. It runs SuperLeaf behind one
gateway. Local deployments expose one HTTP port; public deployments should use
HTTPS through either the bundled TLS override or an external reverse proxy.

## Start

```bash
./superleaf up
```

Open `http://localhost:8080` by default.

The gateway binds to `127.0.0.1` by default. To intentionally expose it on a
trusted LAN, set `SUPERLEAF_BIND_ADDR=0.0.0.0` in `.env` and review
registration, TLS, and firewall settings first.

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
docker load -i images/superleaf-deploy-images.tar.gz
```

## Configure Images

The defaults use GHCR-compatible tags. A local image archive can provide those
same tags after `docker load`, so `./superleaf up` works before the images are
published to GHCR. Edit `.env` to pin release images or use your own registry:

```env
SUPERLEAF_BACKEND_IMAGE=ghcr.io/ohmyyuwan/superleaf-backend:v0.1.0
SUPERLEAF_FRONTEND_IMAGE=ghcr.io/ohmyyuwan/superleaf-frontend:v0.1.0
SUPERLEAF_COLLAB_IMAGE=ghcr.io/ohmyyuwan/superleaf-collab:v0.1.0
```

## Commands

```bash
./superleaf status
./superleaf logs
./superleaf logs backend
./superleaf update
./superleaf backup
./superleaf restore backups/superleaf-backup-YYYYmmdd-HHMMSS.tar.gz
./superleaf down
```

Runtime data is stored under `data/`. Backups are written under `backups/`.

## Package A Release Bundle

Maintainers can create a version-pinned deploy archive with:

```bash
./package.sh v0.1.0
```

The archive is written to `dist/superleaf-deploy-v0.1.0.tar.gz`.
