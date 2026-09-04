# Giant Money — API server + always-on filing scheduler in one container.
FROM node:22-slim

# better-sqlite3 compiles a native addon; curl is used by the Yahoo fetch path.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# install first so dependency layers cache across code changes
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# the database and cookie jar live on a mounted volume, not in the image
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD curl -fsS http://127.0.0.1:${PORT}/healthz || exit 1

CMD ["node", "src/index.js"]
