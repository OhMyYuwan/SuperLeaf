FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY services/collab-server/package*.json ./
RUN npm ci

COPY services/collab-server/tsconfig.json ./
COPY services/collab-server/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    COLLAB_HOST=0.0.0.0 \
    COLLAB_PORT=4444 \
    COLLAB_DATA_DIR=/data/collab

WORKDIR /app

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /data/collab /tmp && \
    chown -R node:node /data/collab /app && \
    chmod 1777 /tmp

EXPOSE 4444

USER node

CMD ["node", "dist/index.js"]
