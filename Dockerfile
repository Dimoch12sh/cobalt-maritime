# syntax=docker/dockerfile:1
# cobalt processing instance for Maritime.sh micro-VM (glibc base — maritime-init needs it)
# Upstream recipe (node:24-alpine → bookworm-slim), sources cloned at build time.

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

FROM base AS build
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# upstream cobalt sources (pinned to v11 tag = 11.7.1)
RUN git clone --depth 1 --branch 11 https://github.com/imputnet/cobalt.git /app

RUN corepack enable \
    && pnpm install --prod --frozen-lockfile \
    && pnpm deploy --filter=@imput/cobalt-api --prod /prod/api

FROM base AS api
WORKDIR /app

COPY --from=build --chown=node:node /prod/api /app
# .git needed by cobalt to figure out its own version
COPY --from=build --chown=node:node /app/.git /app/.git

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Maritime adapter: /health + /chat + gateway-key proxy -> cobalt :9000
COPY proxy.js /app/proxy.js
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

ENV API_URL="http://localhost:9000/"
ENV API_AUTH_REQUIRED=0
ENV DURATION_LIMIT=7200

USER node

CMD ["/app/start.sh"]
