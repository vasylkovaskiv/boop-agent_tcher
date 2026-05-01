# Boop Node server image. Pairs with whisper-service/Dockerfile in
# docker-compose.yml. See README.md → "Deploy to your VPS".

FROM node:20-bookworm-slim AS base

# ca-certificates is required for outbound HTTPS to api.telegram.org and
# the Convex / Composio / Anthropic APIs. tini is the recommended
# init for Node containers (handles SIGTERM cleanly).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Dependencies layer ------------------------------------------------
# Copy lockfile + manifest first so npm ci is cache-friendly across rebuilds
# that don't change dependencies.
COPY package.json package-lock.json ./
RUN npm ci

# --- App source --------------------------------------------------------
# Copy the rest. .dockerignore prunes node_modules, .env*, debug build
# artifacts, etc. so this stays small.
COPY . .

# Build the debug dashboard. Boop boots fine without it — but the resulting
# static files let Traefik serve `/` from the boop container if you decide
# to expose the debug UI behind basicauth. Comment out if you don't need it.
RUN npm run build:debug || echo "debug build skipped"

ENV NODE_ENV=production
ENV PORT=3456
EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('node:http').get('http://127.0.0.1:'+(process.env.PORT||3456)+'/health', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
# `tsx` reads TypeScript directly — no compile step needed at runtime.
CMD ["npx", "tsx", "server/index.ts"]
