import "./env-setup.js";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { addClient } from "./broadcast.js";
import {
  createTelegramWebhookRouter,
  registerTelegramWebhook,
  startTelegramPolling,
} from "./telegram.js";
import { handleUserMessage } from "./interaction-agent.js";
import { loadIntegrations } from "./integrations/registry.js";
import { startCleanupLoop } from "./memory/clean.js";
import { startAutomationLoop } from "./automations.js";
import { startHeartbeatLoop } from "./heartbeat.js";
import { startConsolidationLoop } from "./consolidation.js";
import { cancelAgent, retryAgent } from "./execution-agent.js";
import { createComposioRouter } from "./composio-routes.js";
import { ensureProactiveWatcher } from "./proactive-email.js";
import { preloadLocalModel } from "./embeddings.js";
import { createMemoryRouter } from "./memory-routes.js";
import { startPerplexityKeepAlive } from "./perplexity-keep-alive.js";

async function main() {
  await loadIntegrations();
  startCleanupLoop();
  startAutomationLoop();
  startHeartbeatLoop();
  startConsolidationLoop();
  startPerplexityKeepAlive();
  // No-op when a paid embedding key is set; otherwise downloads/loads the
  // local BGE-large model in the background so the first user-facing
  // recall() doesn't pay the model-load cost.
  preloadLocalModel();

  // If a stable public URL is configured, register the Composio webhook +
  // Gmail trigger now. For ngrok-based dev, scripts/dev.mjs drives the same
  // function once the ngrok URL is known, so we skip when only the local
  // PORT default is available.
  const stableUrl = process.env.PUBLIC_URL;
  if (stableUrl && !stableUrl.includes("localhost")) {
    ensureProactiveWatcher(stableUrl).catch((err) =>
      console.error("[proactive] startup failed", err),
    );
  }

  const app = express();
  app.use(cors());
  // Composio webhook receiver must read raw bytes for HMAC verification, so
  // its body parser is mounted BEFORE the global express.json. Without this
  // ordering the JSON parser consumes the stream first and the raw buffer
  // arrives empty.
  app.use("/composio/webhook", express.raw({ type: "application/json", limit: "2mb" }));
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "boop-agent" });
  });

  const telegramMode = (process.env.TELEGRAM_MODE ?? "polling").toLowerCase();
  if (telegramMode === "webhook") {
    app.use("/telegram", createTelegramWebhookRouter());
  }
  app.use("/composio", createComposioRouter());
  app.use("/memory", createMemoryRouter());

  app.post("/agents/:id/cancel", (req, res) => {
    const ok = cancelAgent(req.params.id);
    res.json({ ok });
  });

  app.post("/consolidate", async (_req, res) => {
    try {
      const { runConsolidation } = await import("./consolidation.js");
      // Fire-and-forget so the HTTP request returns immediately.
      runConsolidation("manual").catch((err) =>
        console.error("[consolidation] manual run failed", err),
      );
      res.json({ ok: true, triggered: "manual" });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/agents/:id/retry", async (req, res) => {
    const result = await retryAgent(req.params.id);
    if (!result) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    res.json(result);
  });

  // Chat endpoint for local testing and the debug dashboard
  app.post("/chat", async (req, res) => {
    const { conversationId, content } = req.body ?? {};
    if (!conversationId || !content) {
      res.status(400).json({ error: "conversationId and content required" });
      return;
    }
    try {
      const result = await handleUserMessage({ conversationId, content });
      res.json({ reply: result.reply });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: String(err) });
    }
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    addClient(ws);
    ws.send(JSON.stringify({ event: "hello", data: { ok: true }, at: Date.now() }));
  });

  const port = Number(process.env.PORT ?? 3456);
  server.listen(port, () => {
    console.log(`boop-agent server listening on :${port}`);
    console.log(`  health      GET  http://localhost:${port}/health`);
    console.log(`  chat        POST http://localhost:${port}/chat`);
    if (telegramMode === "webhook") {
      console.log(`  telegram    POST http://localhost:${port}/telegram/webhook`);
    }
    console.log(`  websocket   WS   ws://localhost:${port}/ws`);
  });

  // Boot the Telegram transport AFTER the HTTP server is listening so the
  // webhook receiver (if enabled) is ready before Telegram starts hitting it.
  if (telegramMode === "webhook") {
    // Telegram refuses to set a webhook to a non-public, non-HTTPS URL.
    // scripts/setup.ts defaults PUBLIC_URL to http://localhost:<PORT> when
    // the user doesn't pick a tunnel — that's truthy, but useless to Telegram.
    // Match the localhost guard the proactive-watcher uses above so the warn
    // actually fires and the user gets a clear hint instead of a swallowed 4xx.
    const isUsable =
      stableUrl &&
      !stableUrl.includes("localhost") &&
      !stableUrl.includes("127.0.0.1");
    if (!isUsable) {
      console.warn(
        "[telegram] TELEGRAM_MODE=webhook but PUBLIC_URL is not set or points at localhost — Telegram requires a public HTTPS URL for webhooks.",
      );
    } else {
      registerTelegramWebhook(stableUrl).catch((err) =>
        console.error("[telegram] webhook registration failed", err),
      );
    }
  } else {
    startTelegramPolling().catch((err) =>
      console.error("[telegram] polling failed to start", err),
    );
  }
}

main().catch((err) => {
  console.error("fatal", err);
  process.exit(1);
});
