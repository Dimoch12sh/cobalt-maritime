# cobalt processing instance for Maritime.sh micro-VM
# Base: official cobalt image (node 24 + ffmpeg, /app = cobalt API, port 9000)
FROM ghcr.io/imputnet/cobalt:11

USER root

# Maritime adapter: /health + /chat + transparent proxy -> cobalt :9000
COPY proxy.js /app/proxy.js
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

# defaults; API_URL is overridden via Maritime env after we know the public URL
ENV API_URL="http://localhost:9000/"
ENV API_AUTH_REQUIRED=0
ENV DURATION_LIMIT=7200
ENV TUNNEL_LIFESPAN=120

USER node

# single string CMD (micro-VM init flattens arrays)
CMD ["/app/start.sh"]
