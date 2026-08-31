# syntax=docker/dockerfile:1
# cobalt processing instance for Maritime.sh micro-VM.
# glibc (bookworm) base — maritime-init is a glibc binary; musl/Alpine => ENOENT (-2).
# PID 1 = node proxy.cjs (supervisor + contract adapter + key-gated proxy).
# cobalt api runs as supervised child; PID 1 never exits (uncaughtException guarded).

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

FROM base AS build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/imputnet/cobalt.git /app \
    && cd /app && git fetch --depth 1 origin a636575b09de1fc55d9b8cd98cac88f5f2f16b42 \
    && git checkout a636575b09de1fc55d9b8cd98cac88f5f2f16b42
RUN corepack enable \
    && pnpm install --prod --frozen-lockfile \
    && pnpm deploy --filter=@imput/cobalt-api --prod /prod/api

FROM base AS api
WORKDIR /app
COPY --from=build --chown=node:node /prod/api /app
COPY --from=build --chown=node:node /app/.git /app/.git
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# .cjs — /app/package.json has "type":"module"; a .js entry crashes ESM => PID 1 death => kernel panic
COPY proxy.cjs /app/proxy.cjs

ENV API_URL="http://localhost:9000/"
ENV API_AUTH_REQUIRED=0
ENV DURATION_LIMIT=7200

USER node
EXPOSE 18789
CMD ["node", "proxy.cjs"]
