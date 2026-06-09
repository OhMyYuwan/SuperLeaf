FROM node:22-bookworm-slim AS node-runtime

FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS runtime

ARG INSTALL_TEXLIVE=false
ARG APP_UID=10001
ARG APP_GID=10001

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:${PATH}" \
    HOME=/data/home \
    XDG_CACHE_HOME=/data/cache \
    UV_CACHE_DIR=/data/cache/uv \
    NPM_CONFIG_CACHE=/data/cache/npm \
    YLW_DATA_DIR=/data

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      git && \
    if [ "${INSTALL_TEXLIVE}" = "true" ]; then \
      apt-get install -y --no-install-recommends \
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
    ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

RUN groupadd --gid "${APP_GID}" appuser && \
    useradd --uid "${APP_UID}" --gid "${APP_GID}" --home-dir /data/home --no-create-home --shell /usr/sbin/nologin appuser

COPY services/backend/pyproject.toml services/backend/uv.lock ./
COPY services/backend/app ./app
COPY services/local-agent-host ./services/local-agent-host
COPY services/shared/superleaf-tools.json ./services/shared/superleaf-tools.json

RUN uv sync --frozen --no-dev

RUN mkdir -p /data/home /data/cache /tmp && \
    chown -R appuser:appuser /data /app && \
    chmod 1777 /tmp

EXPOSE 8000

USER appuser

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
