#!/usr/bin/env node
// One command to run Boop locally: server + convex + debug dashboard (+ optional ngrok).
// Prefixes each child's output so you can tell who's saying what.
//
// With Telegram in polling mode (default) you don't need a public URL at all.
// Ngrok is only spun up when:
//   * PUBLIC_URL is unset/localhost AND COMPOSIO_API_KEY is set (so we can
//     auto-register a Composio webhook URL), or
//   * TELEGRAM_MODE=webhook (so Telegram can deliver updates back).

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// --- preflight: Convex types must exist ----------------------------------
if (!existsSync(resolve(root, "convex/_generated/api.js"))) {
  console.error(`
┌─────────────────────────────────────────────────────────────┐
│  Convex types haven't been generated yet.                   │
│                                                             │
│  Run this first:                                            │
│    npm run setup           (full interactive setup)         │
│    npx convex dev --once   (just generate types)            │
└─────────────────────────────────────────────────────────────┘
`);
  process.exit(1);
}

// --- read PORT from .env.local ------------------------------------------
function readEnv() {
  const p = resolve(root, ".env.local");
  if (!existsSync(p)) return {};
  const env = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*?)(?:\s+#.*)?$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const envVars = readEnv();
const port = envVars.PORT || "3456";
const ngrokDomain = envVars.NGROK_DOMAIN || "";
const publicUrl = envVars.PUBLIC_URL || "";
const telegramMode = (envVars.TELEGRAM_MODE || "polling").toLowerCase();
const hasStaticUrl =
  publicUrl && !publicUrl.includes("localhost") && !publicUrl.includes("127.0.0.1");

// We only spin up ngrok when something actually needs a public URL:
//   * Telegram webhook mode → /telegram/webhook needs to be reachable.
//   * Composio + no static URL → we want to register the Composio webhook on
//     each restart so proactive email notifications work in dev too.
const needsPublicUrl =
  telegramMode === "webhook" ||
  (Boolean(envVars.COMPOSIO_API_KEY) && !hasStaticUrl);
const useNgrok = needsPublicUrl && (!hasStaticUrl || Boolean(ngrokDomain));

// --- binary detection ---------------------------------------------------
function hasBinary(name) {
  return new Promise((ok) => {
    const lookup = process.platform === "win32" ? "where" : "which";
    const child = spawn(lookup, [name], { stdio: "ignore" });
    child.on("exit", (code) => ok(code === 0));
    child.on("error", () => ok(false));
  });
}

// --- color-prefixed child runner ----------------------------------------
const C = {
  server: "\x1b[36m",
  convex: "\x1b[35m",
  debug: "\x1b[33m",
  ngrok: "\x1b[32m",
  upstream: "\x1b[34m",
  banner: "\x1b[1;32m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};

// Vite's http-proxy attaches its own socket error logger that can't be removed
// via configure(). EPIPE on WS reconnects is harmless — filter it at the
// stream level so the logs stay readable.
const NOISE_TRIGGERS = [
  /\[vite\] ws proxy socket error/,
  /\[vite\] ws proxy error/,
  /Error: write EPIPE/,
  /Error: read ECONNRESET/,
  /AggregateError \[ECONNREFUSED\]/,
];
const STACK_LINE = /^\s+at\s/;

function run(name, cmd, args, readyPattern) {
  const child = spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  const prefix = `${C[name]}${name.padEnd(6)}${C.reset} │ `;
  let buf = "";
  let suppressing = false;
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  const feed = (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);

      // ANSI-strip for matching without disturbing the display output.
      const plain = line.replace(/\x1b\[[0-9;]*m/g, "");

      if (NOISE_TRIGGERS.some((r) => r.test(plain))) {
        suppressing = true;
        continue;
      }
      if (suppressing) {
        if (STACK_LINE.test(plain) || plain.trim() === "") continue;
        suppressing = false;
      }

      if (line.trim()) process.stdout.write(prefix + line + "\n");
      if (readyPattern && readyPattern.test(plain)) resolveReady();
    }
  };
  child.stdout.on("data", feed);
  child.stderr.on("data", feed);
  child.ready = ready;
  return child;
}

// --- ngrok URL banner: poll local API after launch ----------------------
async function waitForNgrokUrl(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch("http://127.0.0.1:4040/api/tunnels");
      if (res.ok) {
        const data = await res.json();
        const https = data.tunnels?.find((t) => t.proto === "https")?.public_url;
        if (https) return https;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

function showBanner({ url, stable, headline }) {
  const line = "═".repeat(68);
  const dashboard = `http://localhost:5173`;
  const lines = [
    `${C.banner}${line}`,
    `  Boop is ready — ${headline}`,
    ``,
    `  🐶 Debug dashboard (click me):   ${dashboard}`,
  ];
  if (url) lines.push(`  🌐 Public URL:                   ${url}`);
  if (telegramMode === "webhook" && url) {
    lines.push(`  ✈ Telegram webhook:              ${url}/telegram/webhook`);
  }
  if (envVars.COMPOSIO_API_KEY && url) {
    lines.push(`  📮 Composio webhook:              ${url}/composio/webhook`);
  }
  lines.push(line + C.reset);
  console.log("\n" + lines.join("\n") + "\n");
  if (!stable && url) {
    console.log(
      `${C.dim}  ℹ The public URL above is from ngrok and rotates each restart.${C.reset}\n`,
    );
  }
}

// --- main ---------------------------------------------------------------
let ngrokInstalled = false;
if (useNgrok) {
  ngrokInstalled = await hasBinary("ngrok");
  if (!ngrokInstalled) {
    console.log(`
${C.ngrok}! ngrok is not installed — running without a public tunnel.${C.reset}
${C.dim}  Install:   brew install ngrok         (macOS)
             or download from https://ngrok.com/download
  Auth:      ngrok config add-authtoken <token>
             (free token at https://dashboard.ngrok.com)
  Without ngrok the debug dashboard at http://localhost:5173 still works,
  Telegram polling still works, but Composio webhook + Telegram webhook
  mode won't.${C.reset}
`);
  }
}

console.log(`\nBoop dev starting on port ${port}. Ctrl-C to stop everything.\n`);

// Background "new-version available?" check. Runs concurrently with the
// child services; output is prefixed with `upstream │ ` by run() so it
// won't collide with startup logs. Silent on the happy path. Not added to
// the `children` array because it exits on its own — we don't want its
// non-zero exit (which shouldn't happen but hedge anyway) to tear down dev.
run("upstream", "node", ["scripts/check-upstream.mjs"]);

const serverChild = run(
  "server",
  "npx",
  ["tsx", "watch", "server/index.ts"],
  /listening on :/,
);
const convexChild = run(
  "convex",
  "npx",
  ["convex", "dev"],
  /Convex functions ready/,
);
const debugChild = run(
  "debug",
  "npx",
  ["vite", "--config", "debug/vite.config.ts"],
  /Local:\s+http/,
);
const children = [serverChild, convexChild, debugChild];

let ngrokUrlReady = Promise.resolve(null);
if (useNgrok && ngrokInstalled) {
  const args = ngrokDomain
    ? ["http", port, `--domain=${ngrokDomain}`, "--log=stdout", "--log-format=term", "--log-level=info"]
    : ["http", port, "--log=stdout", "--log-format=term", "--log-level=info"];
  const ngrokChild = run("ngrok", "ngrok", args);
  children.push(ngrokChild);
  ngrokUrlReady = waitForNgrokUrl().catch(() => null);
}

async function autoRegisterComposioWebhook(publicUrl) {
  if (envVars.COMPOSIO_AUTO_WEBHOOK === "false") return;
  if (!envVars.COMPOSIO_API_KEY) return;
  const prefix = `${C.ngrok}composio${C.reset} │ `;
  const child = spawn("npx", ["tsx", "scripts/composio-webhook.ts", publicUrl], {
    cwd: root,
    env: { ...process.env },
  });
  child.stdout.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim()) process.stdout.write(prefix + line + "\n");
    }
  });
  child.stderr.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim()) process.stdout.write(prefix + line + "\n");
    }
  });
  await new Promise((r) => child.on("exit", r));
}

Promise.all([
  serverChild.ready,
  convexChild.ready,
  debugChild.ready,
  ngrokUrlReady,
])
  .then(async ([, , , ngrokUrl]) => {
    const url = ngrokUrl || (hasStaticUrl ? publicUrl : "");
    if (url && envVars.COMPOSIO_API_KEY) {
      await autoRegisterComposioWebhook(url);
    }
    if (url) {
      const stable = Boolean(ngrokDomain) || hasStaticUrl;
      const headline = stable
        ? `your STABLE public URL is live.`
        : `ngrok tunnel is live.`;
      showBanner({ url, stable, headline });
    } else {
      const line = "═".repeat(68);
      console.log(`
${C.banner}${line}
  Boop is running locally (Telegram polling).

  🐶 Debug dashboard:   http://localhost:5173

  ${
    telegramMode === "webhook"
      ? "⚠ TELEGRAM_MODE=webhook but no public URL — Telegram updates won't be delivered. Switch to polling or expose a public URL."
      : "ℹ Telegram polling is active — message your bot to test."
  }
${line}${C.reset}
`);
    }
  })
  .catch(() => {});

let shuttingDown = false;
const shutdown = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(code), 500);
};
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
for (const c of children) {
  c.on("exit", (code) => {
    if (!shuttingDown && code !== null && code !== 0) {
      console.error(`\nA child process exited with code ${code}. Shutting down.`);
      shutdown(code);
    }
  });
}
