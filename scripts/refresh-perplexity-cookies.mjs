#!/usr/bin/env node
// scripts/refresh-perplexity-cookies.mjs
//
// Pulls fresh Perplexity Pro cookies from a Dolphin Anty browser profile
// (running locally on YOUR machine, not the bot's server) and pushes them
// into the bot's Convex database. Designed to be run by a human every 1–4
// weeks, or automatically via launchd / cron.
//
// Prerequisites:
//   - Dolphin Anty installed and the Local API enabled (default port 3001).
//   - A browser profile in Dolphin where you've logged into Perplexity Pro.
//   - Your CONVEX_URL env var pointing at the bot's deployment (the same one
//     the bot reads — typically defined in `.env.local`).
//
// Usage:
//   npm run refresh-perplexity-cookies -- --profile-id=<dolphin-profile-id>
//
// Optional env:
//   DOLPHIN_LOCAL_API   default http://localhost:3001
//   DOLPHIN_API_TOKEN   optional, free tier doesn't need it
//   PERPLEXITY_TIMEZONE default UTC; should match the timezone of the
//                       residential proxy the bot uses
//   CONVEX_URL          required — the bot's deployment URL
//
// Cookie name we care about most: `__Secure-next-auth.session-token`. WITHOUT
// this exact cookie name (note the underscore inside `__Secure-`), Perplexity
// silently drops the request to the free tier — no error, just degraded
// answers. The script verifies it's present before pushing.

import "dotenv/config";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const REQUIRED_COOKIE = "__Secure-next-auth.session-token";

function parseArgs() {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--")) {
      const [k, ...rest] = arg.slice(2).split("=");
      out[k] = rest.join("=") || true;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const profileId = args["profile-id"];
  if (!profileId || profileId === true) {
    console.error("Usage: npm run refresh-perplexity-cookies -- --profile-id=<dolphin-profile-id>");
    process.exit(1);
  }
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    console.error(
      "CONVEX_URL is not set. Either export it or run from the project root with .env.local present.",
    );
    process.exit(1);
  }
  const dolphinApi = (process.env.DOLPHIN_LOCAL_API ?? "http://localhost:3001").replace(/\/+$/, "");
  const dolphinToken = process.env.DOLPHIN_API_TOKEN ?? "";
  const timezone = process.env.PERPLEXITY_TIMEZONE ?? "UTC";

  console.log(`[refresh] starting profile ${profileId} via ${dolphinApi}`);
  const startResp = await dolphinFetch(`${dolphinApi}/v1.0/browser_profiles/${profileId}/start?automation=1`, {
    headers: dolphinHeaders(dolphinToken),
  });
  if (!startResp.success) {
    console.error("[refresh] failed to start Dolphin profile:", startResp);
    process.exit(2);
  }
  // Dolphin returns { automation: { port, wsEndpoint } } — the wsEndpoint is
  // a CDP URL we can attach to with puppeteer-core.
  const wsEndpoint = startResp?.automation?.wsEndpoint;
  if (!wsEndpoint) {
    console.error("[refresh] Dolphin response missing automation.wsEndpoint");
    console.error("Full response:", JSON.stringify(startResp, null, 2));
    process.exit(2);
  }
  console.log(`[refresh] CDP endpoint: ${wsEndpoint}`);

  const puppeteer = await import("puppeteer-core");
  const browser = await puppeteer.default.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
  let cookieString = "";
  let userAgent = "";
  try {
    const pages = await browser.pages();
    const page = pages[0] ?? (await browser.newPage());
    // Navigate to Perplexity to ensure all relevant cookies are set on the
    // current jar. If the user's already on the site this is a no-op. We
    // wait for `networkidle0` so deferred cookie writes (e.g. analytics
    // beacons that piggyback on the auth flow) finish too.
    await page.goto("https://www.perplexity.ai/", { waitUntil: "networkidle2", timeout: 30000 });
    userAgent = await page.evaluate(() => navigator.userAgent);
    const cookies = await page.cookies("https://www.perplexity.ai/");
    const required = cookies.find((c) => c.name === REQUIRED_COOKIE);
    if (!required) {
      console.error(
        `[refresh] FATAL: Dolphin profile ${profileId} does not have a "${REQUIRED_COOKIE}" cookie set.`,
      );
      console.error("That means the profile is not logged into Perplexity Pro, or it's logged out / expired.");
      console.error("Open the Dolphin profile manually, log into perplexity.ai, then re-run this script.");
      process.exit(3);
    }
    cookieString = cookies
      .filter((c) => c.domain.endsWith("perplexity.ai") || c.domain === ".perplexity.ai")
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  } finally {
    // Detach (don't close — the user might be doing other stuff in the same
    // browser; closing kills the profile entirely).
    await browser.disconnect().catch(() => undefined);
  }

  console.log(`[refresh] extracted ${cookieString.split(";").length} cookies (UA len ${userAgent.length})`);

  // Push to Convex.
  const convex = new ConvexHttpClient(convexUrl);
  await convex.mutation(api.perplexity.updateCookies, {
    cookies: cookieString,
    userAgent,
    timezone,
  });
  console.log(`[refresh] cookies updated in Convex (timezone=${timezone})`);
  process.exit(0);
}

function dolphinHeaders(token) {
  const h = { "Content-Type": "application/json" };
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

async function dolphinFetch(url, init) {
  const resp = await fetch(url, init);
  if (!resp.ok) {
    let body = "";
    try {
      body = await resp.text();
    } catch {}
    throw new Error(`Dolphin API ${resp.status}: ${body.slice(0, 500)}`);
  }
  return resp.json();
}

main().catch((err) => {
  console.error("[refresh] fatal:", err);
  process.exit(99);
});
