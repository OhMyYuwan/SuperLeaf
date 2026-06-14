FROM node:22-bookworm-slim AS frontend-build

ARG VITE_BACKEND_URL=
ARG VITE_COLLAB_WS_URL=/collab
ARG VITE_COLLAB_PORT=4444

ENV VITE_BACKEND_URL=${VITE_BACKEND_URL} \
    VITE_COLLAB_WS_URL=${VITE_COLLAB_WS_URL} \
    VITE_COLLAB_PORT=${VITE_COLLAB_PORT}

WORKDIR /app/frontend

COPY services/frontend/package*.json ./
RUN npm ci

COPY services/frontend/index.html ./
COPY services/frontend/tsconfig*.json ./
COPY services/frontend/vite.config.ts ./
COPY services/frontend/public ./public
COPY services/frontend/src ./src
COPY services/shared /app/shared

RUN npm run build

FROM node:22-bookworm-slim AS collab-build

WORKDIR /app/collab

COPY services/collab-server/package*.json ./
RUN npm ci

COPY services/collab-server/tsconfig.json ./
COPY services/collab-server/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS node-runtime

FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS runtime

ARG INSTALL_TEXLIVE=true
ARG APP_UID=10001
ARG APP_GID=10001
ARG APT_MIRROR=http://deb.debian.org/debian
ARG APT_SECURITY_MIRROR=http://deb.debian.org/debian-security

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH="/app/backend/.venv/bin:${PATH}" \
    HOME=/data/home \
    XDG_CACHE_HOME=/data/cache \
    UV_CACHE_DIR=/data/cache/uv \
    NPM_CONFIG_CACHE=/data/cache/npm \
    YLW_DATA_DIR=/data/backend \
    YLW_COLLAB_SERVER_URL=http://127.0.0.1:4444 \
    BACKEND_URL=http://127.0.0.1:8000 \
    COLLAB_HOST=127.0.0.1 \
    COLLAB_PORT=4444 \
    COLLAB_DATA_DIR=/data/collab \
    COLLAB_WS_PATH_PREFIX=/collab \
    SUPERLEAF_BROWSER_BACKEND_URL= \
    SUPERLEAF_BROWSER_COLLAB_WS_URL=/collab

WORKDIR /app

RUN sed -i "s|http://deb.debian.org/debian-security|${APT_SECURITY_MIRROR}|g; s|http://deb.debian.org/debian|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources && \
    apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 update && \
    apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      gosu \
      nginx-light && \
    if [ "${INSTALL_TEXLIVE}" = "true" ]; then \
      apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 install -y --no-install-recommends \
        latexmk \
        biber \
        ghostscript \
        python3-pygments \
        fonts-noto-cjk \
        texlive-latex-base \
        texlive-latex-recommended \
        texlive-latex-extra \
        texlive-plain-generic \
        texlive-science \
        texlive-publishers \
        texlive-bibtex-extra \
        texlive-fonts-recommended \
        texlive-fonts-extra \
        texlive-lang-chinese \
        texlive-luatex \
        texlive-xetex; \
    fi && \
    rm -rf /var/lib/apt/lists/*

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules

RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && \
    groupadd --gid "${APP_GID}" appuser && \
    useradd --uid "${APP_UID}" --gid "${APP_GID}" --home-dir /data/home --no-create-home --shell /usr/sbin/nologin appuser

WORKDIR /app/backend
COPY services/backend/pyproject.toml services/backend/uv.lock ./
COPY services/backend/app ./app
RUN uv sync --frozen --no-dev

WORKDIR /app
COPY services/local-agent-host ./services/local-agent-host
COPY services/shared/superleaf-tools.json ./services/shared/superleaf-tools.json
COPY services/shared/superleaf-tools.json ./shared/superleaf-tools.json
COPY --from=collab-build /app/collab/package*.json ./collab/
COPY --from=collab-build /app/collab/node_modules ./collab/node_modules
COPY --from=collab-build /app/collab/dist ./collab/dist
COPY --from=frontend-build /app/frontend/dist /usr/share/superleaf/html
COPY services/all-in-one/nginx.conf /etc/nginx/conf.d/default.conf
COPY services/all-in-one/entrypoint.sh /usr/local/bin/superleaf-all-in-one

RUN mkdir -p /data/backend /data/collab /data/home /data/cache /data/logs /run/nginx /var/log/nginx /tmp && \
    chown -R appuser:appuser /data /app /usr/share/superleaf/html && \
    chmod 1777 /tmp && \
    chmod +x /usr/local/bin/superleaf-all-in-one

EXPOSE 8080 80 443

HEALTHCHECK --interval=10s --timeout=3s --retries=12 --start-period=20s \
  CMD curl -fsS http://127.0.0.1:8080/api/health >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/superleaf-all-in-one"]
