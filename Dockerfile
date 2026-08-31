# syntax=docker/dockerfile:1
# Cobalt processing instance for Maritime.sh micro-VM.
#   - glibc (bookworm) base; maritime-init is glibc.
#   - PID 1 = node proxy.cjs (supervisor + contract adapter + key-gated proxy).
#   - cobalt api runs as supervised child on :9000.
#   - yt-session-generator runs as supervised child on :8080 (with Xvfb+Chromium).
# cobalt queries ysg via POST /get_pot; shim in proxy.cjs maps it to ysg's GET /token.

# ---------- base: toolchain + xvfb + chromium + python for ysg ----------
FROM node:24-bookworm-slim AS base

ENV DEBIAN_FRONTEND=noninteractive \
    PNPM_HOME="/pnpm" \
    PATH="/pnpm:/usr/local/bin:/usr/bin:/bin:$PATH"

# chromium + xvfb + ffmpeg + python for ysg (later stages inherit)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git ca-certificates curl \
        python3 python3-pip python3-venv \
        xvfb xauth \
        libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
        libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
        libgbm1 libpango-1.0-0 libcairo2 libasound2 libatk-bridge2.0-0 \
        libatspi2.0-0 fonts-liberation \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# chromium itself (Debian-slim doesn't ship it; use google-chrome .deb directly — apt chromium not in main)
RUN set -eux; \
    curl -sSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb; \
    apt-get update; \
    apt-get install -y --no-install-recommends /tmp/chrome.deb; \
    rm -rf /var/lib/apt/lists/* /tmp/chrome.deb; \
    google-chrome --version || echo "chrome version probe failed"

# ---------- build: cobalt api (node) ----------
FROM base AS build-cobalt
WORKDIR /app
RUN git clone --depth 1 https://github.com/imputnet/cobalt.git /app \
    && cd /app && git fetch --depth 1 origin a636575b09de1fc55d9b8cd98cac88f5f2f16b42 \
    && git checkout a636575b09de1fc55d9b8cd98cac88f5f2f16b42
RUN corepack enable \
    && pnpm install --prod --frozen-lockfile \
    && pnpm deploy --filter=@imput/cobalt-api --prod /prod/api

# ---------- build: yt-session-generator (python venv) ----------
FROM base AS build-ysg
RUN git clone --depth 1 https://github.com/imputnet/yt-session-generator.git /src/ysg
WORKDIR /src/ysg
RUN python3 -m venv /opt/ysg-venv \
    && /opt/ysg-venv/bin/pip install --no-cache-dir -r requirements.txt \
    && /opt/ysg-venv/bin/pip install --no-cache-dir --upgrade nodriver
# patch: chromium-driven anti-bot detection needs slower startup
RUN sed -i 's/await self.sleep(0.5)/await self.sleep(2)/' /opt/ysg-venv/lib/python3.*/site-packages/nodriver/core/browser.py || true
# patch: ysg runs as root under our supervisor, nodriver 0.32 doesn't auto-disable sandbox — force it
RUN sed -i 's/browser = await nodriver.start(headless=False,/browser = await nodriver.start(headless=False, sandbox=False,/g' /src/ysg/potoken_generator/extractor.py || true
# add extra chrome flags: no-sandbox for root, dev-shm for docker, autoplay policy —
# without user gesture Chrome 152 refuses to start playback => no POST /youtubei/v1/player => ysg timeout
RUN sed -i 's|browser_executable_path=self.browser_path,|browser_executable_path=self.browser_path, browser_args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--autoplay-policy=no-user-gesture-required", "--mute-audio", "--lang=en-US"],|' /src/ysg/potoken_generator/extractor.py || true

# ---------- final: runtime ----------
FROM base AS api

WORKDIR /app
COPY --from=build-cobalt --chown=node:node /prod/api /app
COPY --from=build-cobalt --chown=node:node /app/.git /app/.git
COPY --from=build-ysg    --chown=node:node /src/ysg /app/yt-session-generator
COPY --from=build-ysg    --chown=node:node /opt/ysg-venv /opt/ysg-venv

# supervisor: handles cobalt + ysg as child processes
COPY proxy.cjs /app/proxy.cjs

ENV PATH="/opt/ysg-venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    API_URL="http://localhost:9000/" \
    API_AUTH_REQUIRED=0 \
    DURATION_LIMIT=7200 \
    # cobalt queries <server>/get_pot (POST); our proxy.cjs shim maps it to ysg's GET /token.
    # so point cobalt at the PROXY port, not at ysg directly
    YOUTUBE_SESSION_SERVER="http://127.0.0.1:18789/" \
    YOUTUBE_SESSION_INNERTUBE_CLIENT="WEB" \
    YSG_UPDATE_INTERVAL=300

USER node
EXPOSE 18789
CMD ["node", "proxy.cjs"]
