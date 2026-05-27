FROM node:22-alpine AS build

ARG VITE_BACKEND_URL=
ARG VITE_COLLAB_WS_URL=
ARG VITE_COLLAB_PORT=4444

ENV VITE_BACKEND_URL=${VITE_BACKEND_URL} \
    VITE_COLLAB_WS_URL=${VITE_COLLAB_WS_URL} \
    VITE_COLLAB_PORT=${VITE_COLLAB_PORT}

WORKDIR /app

COPY services/frontend/package*.json ./
RUN npm ci

COPY services/frontend/index.html ./
COPY services/frontend/tsconfig*.json ./
COPY services/frontend/vite.config.ts ./
COPY services/frontend/public ./public
COPY services/frontend/src ./src

RUN npm run build

FROM nginx:1.27-alpine AS runtime

COPY services/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY services/frontend/docker/40-superleaf-config.sh /docker-entrypoint.d/40-superleaf-config.sh
COPY --from=build /app/dist /usr/share/nginx/html
RUN chmod +x /docker-entrypoint.d/40-superleaf-config.sh

EXPOSE 5173
