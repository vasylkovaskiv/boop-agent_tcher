# Boop Node server image. Pairs with whisper-service/Dockerfile in
# docker-compose.yml. See README.md → "Deploy to your VPS".

FROM node:20-bookworm-slim AS base

# ca-certificates is required for outbound HTTPS to api.telegram.org and
# the Convex / Composio / Anthropic APIs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Dependencies layer ------------------------------------------------
# Copy lockfile + manifest first so npm ci is cache-friendly across rebuilds
# that don't change dependencies.
COPY package.json package-lock.json ./
RUN npm ci

# The Claude Agent SDK uses ProcessTransport — it spawns the `claude` CLI
# as a child process and pipes JSON over stdio. The binary must be on PATH,
# so install it globally before we drop privileges.
RUN npm install -g @anthropic-ai/claude-code

# --- App source --------------------------------------------------------
# Copy the rest. .dockerignore prunes node_modules, .env*, debug build
# artifacts, etc. so this stays small.
COPY . .

# Build the debug dashboard. Boop boots fine without it — but the resulting
# static files let Traefik serve `/` from the boop container if you decide
# to expose the debug UI behind basicauth. Comment out if you don't need it.
RUN npm run build:debug || echo "debug build skipped"

# --- Non-root user -----------------------------------------------------
# The Claude Code CLI refuses to run with --dangerously-skip-permissions
# (which the Agent SDK passes as --permission-mode bypassPermissions) when
# the process is owned by root. Docker defaults to root, so we create a
# dedicated `boop` user and switch to it for runtime.
RUN groupadd --gid 1001 boop \
 && useradd --uid 1001 --gid boop --shell /bin/sh --create-home boop \
 && chown -R boop:boop /app

# Bake Claude Code settings into the runtime user's home so the spawned
# `claude` process picks up AgentRouter routing and headless-friendly env
# without needing extra files mounted from the host.
#
# Why each flag:
#   ANTHROPIC_BASE_URL           → route Claude calls through AgentRouter
#   ANTHROPIC_MODEL              → claude-sonnet-4-x is NOT on AgentRouter,
#                                  pin haiku-4-5 to avoid 503s on first call
#   ANTHROPIC_SMALL_FAST_MODEL   → same model for the SDK's "small" path
#   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, DISABLE_TELEMETRY,
#   DISABLE_ERROR_REPORTING, DISABLE_AUTOUPDATER, DISABLE_COST_WARNINGS
#                                → headless mode hygiene; no surprise net I/O
#   permissions.allow + askBeforeRunningTool=false
#                                → SDK already passes bypassPermissions, this
#                                  is a belt-and-suspenders for any code path
#                                  that re-reads settings.
RUN mkdir -p /home/boop/.claude && echo '{\
  "env": {\
    "ANTHROPIC_BASE_URL": "https://agentrouter.org/",\
    "ANTHROPIC_MODEL": "claude-haiku-4-5-20251001",\
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4-5-20251001",\
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",\
    "DISABLE_TELEMETRY": "1",\
    "DISABLE_ERROR_REPORTING": "1",\
    "DISABLE_AUTOUPDATER": "1",\
    "DISABLE_COST_WARNINGS": "1"\
  },\
  "permissions": {\
    "allow": ["Read(*)","Search(*)","Edit(*)","Write(*)","Bash(*)"]\
  },\
  "askBeforeRunningTool": false\
}' > /home/boop/.claude/settings.json \
 && chown -R boop:boop /home/boop/.claude

USER boop

ENV NODE_ENV=production
ENV PORT=3456
EXPOSE 3456

# start-period bumped to 90s because the local embeddings model
# (Xenova/bge-large-en-v1.5, ~440 MB) needs 30–50s to load on first boot;
# retries bumped to 5 so a slow first-time download doesn't fail the check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=5 \
  CMD node -e "require('node:http').get('http://127.0.0.1:'+(process.env.PORT||3456)+'/health', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"

# No tini. Earlier we used `tini -s` as the init wrapper, but it forwarded
# SIGTERM emitted by the Claude CLI subprocess back to the Node parent and
# silently shut down the whole container. Running Node as PID 1 lets it
# manage its own children; signal handling stays correct because Node's
# default behaviour ignores SIGCHLD from already-reaped children.
#
# `tsx` reads TypeScript directly — no compile step needed at runtime.
CMD ["npx", "tsx", "server/index.ts"]
