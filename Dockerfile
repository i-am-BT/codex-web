# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    APP_NAME="Codex Web" \
    HOST=0.0.0.0 \
    PORT=36354 \
    PUBLIC_HOST=127.0.0.1 \
    CODEX_HOME=/data/codex \
    CODEX_WEB_RUNTIME_DIR=/data/runtime \
    CODEX_BIN=/usr/local/bin/codex \
    CODEX_DESKTOP_IPC_ENABLED=false \
    CODEX_CONFIG_WRITABLE=false \
    COOKIE_SECURE=false

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git ripgrep \
  && npm install -g @openai/codex@0.145.0 \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/* \
  && mkdir -p /data/codex /data/runtime /workspaces \
  && chown -R node:node /data /workspaces

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server.mjs automation-store.mjs app-server-client.mjs desktop-ipc-client.mjs \
     image-prompt-library.mjs image-prompt.js image-prompt.css native-sessions.mjs \
     playground-updater.mjs plugins-catalog.mjs skills-catalog.mjs sub-quota.mjs ui.css ./
COPY scripts ./scripts
COPY vendor ./vendor
COPY runtime.example ./runtime.example
COPY codex.config.example.toml codex.env.example ./

USER node
EXPOSE 36354
VOLUME ["/data/codex", "/data/runtime", "/workspaces"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-36354}/api/health" >/dev/null || exit 1
CMD ["node", "server.mjs"]
