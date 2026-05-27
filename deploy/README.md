# SuperLeaf Deploy

This folder is the user-facing deployment bundle. It runs SuperLeaf behind one
gateway so users only expose one HTTP port.

## Start

```bash
cp .env.example .env
./superleaf up
```

Open `http://localhost:8080` by default.

The gateway binds to `127.0.0.1` by default. To intentionally expose it on a
trusted LAN, set `SUPERLEAF_BIND_ADDR=0.0.0.0` in `.env` and review
registration, TLS, and firewall settings first.

Public registration is disabled by default. Before creating the first admin
account, set a private `YLW_BOOTSTRAP_TOKEN` in `.env` and enter that token on
the registration page. Do not use a shared or checked-in token.

Set a separate private `YLW_COLLAB_INTERNAL_TOKEN` in `.env` before starting.
Backend uses it when reading Yjs document snapshots from Collab Server, and
Collab Server rejects `/docs/:docId/text` without this internal token.

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
