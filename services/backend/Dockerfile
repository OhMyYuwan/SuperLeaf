FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS runtime

ARG INSTALL_TEXLIVE=false

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:${PATH}" \
    YLW_DATA_DIR=/data

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      git && \
    if [ "${INSTALL_TEXLIVE}" = "true" ]; then \
      apt-get install -y --no-install-recommends \
        latexmk \
        texlive-latex-base \
        texlive-latex-recommended \
        texlive-fonts-recommended \
        texlive-xetex; \
    fi && \
    rm -rf /var/lib/apt/lists/*

COPY services/backend/pyproject.toml services/backend/uv.lock ./
COPY services/backend/app ./app

RUN uv sync --frozen --no-dev

RUN mkdir -p /data

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
