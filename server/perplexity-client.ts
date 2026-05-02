import { randomUUID } from "node:crypto";
import {
  Dispatcher,
  ProxyAgent,
  Socks5ProxyAgent,
  fetch as undiciFetch,
} from "undici";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { hashQuery, cacheTtlMs } from "./perplexity-cache.js";

const PERPLEXITY_URL = "https://www.perplexity.ai/rest/sse/perplexity_ask";
const KEEPALIVE_URL = "https://www.perplexity.ai/api/auth/session";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const DEFAULT_SUPPORTED_BLOCKS = [
  "answer_modes",
  "media_items",
  "knowledge_cards",
  "inline_entity_cards",
  "place_widgets",
  "finance_widgets",
  "sports_widgets",
  "shopping_widgets",
  "search_result_widgets",
];

export type PerplexityMode = "pro" | "concise";

export interface PerplexitySearchOptions {
  query: string;
  mode?: PerplexityMode;
  /** Override the default model_preference. Most callers should leave this. */
  modelPreference?: string;
  /** BCP-47 like "en-US", "ru-RU". Defaults to "en-US" — Perplexity's best-quality language. */
  language?: string;
  /** When provided, enables follow-up via `last_backend_uuid`. */
  conversationId?: string;
  signal?: AbortSignal;
}

export interface PerplexitySource {
  url: string;
  title: string;
  snippet?: string;
}

export interface PerplexitySearchResult {
  answer: string;
  sources: PerplexitySource[];
  thinkingSteps: string[];
  model: string;
  backendUuid?: string;
  fromCache?: boolean;
}

// Perplexity rate-limits per (cookie pair, IP) and parallel requests from a
// single account look like account-sharing — fast path to a 429 / suspension.
// Sequential FIFO queue with jitter between jobs.
const queue: Array<() => Promise<unknown>> = [];
let processing = false;
let dispatcherCache: Dispatcher | null = null;
let dispatcherKey: string | null = null;

function getDispatcher(): Dispatcher | null {
  const proxyUrl = process.env.PERPLEXITY_PROXY_URL;
  if (!proxyUrl) return null;
  if (dispatcherCache && dispatcherKey === proxyUrl) return dispatcherCache;
  // ProxyAgent handles http:// and https:// proxy URLs out of the box. For
  // socks5:// residential endpoints (NodeMaven, Smartproxy, IPRoyal, asocks,
  // …) undici exposes Socks5ProxyAgent which is wired up here as a thin
  // parallel branch — kept narrow on purpose so the rest of the client stays
  // scheme-agnostic. We accept socks://, socks5:// and socks5h:// so users
  // can paste whatever their proxy provider gave them; undici only constructs
  // against socks5:// so socks5h:// is normalized down. The "h" in socks5h
  // is the curl convention for "resolve DNS on the proxy side" — that's the
  // only mode SOCKS5 supports anyway, so collapsing the schemes is
  // semantically a no-op.
  let agent: Dispatcher;
  if (
    proxyUrl.startsWith("socks5://") ||
    proxyUrl.startsWith("socks5h://") ||
    proxyUrl.startsWith("socks://")
  ) {
    const normalizedUrl = proxyUrl.replace(/^socks5h:\/\//, "socks5://");
    agent = new Socks5ProxyAgent(normalizedUrl);
  } else {
    agent = new ProxyAgent(proxyUrl);
  }
  dispatcherCache = agent;
  dispatcherKey = proxyUrl;
  return agent;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function perplexitySearch(
  opts: PerplexitySearchOptions,
): Promise<PerplexitySearchResult> {
  const mode: PerplexityMode = opts.mode ?? "pro";
  const language = opts.language ?? "en-US";
  // Always use the Sonnet-thinking model — even for `concise` mode where
  // Perplexity's UI normally serves a lighter SKU. We're paying the same Pro
  // budget either way; might as well get the highest-quality answer that
  // Perplexity's stack can produce. Callers can still override via
  // opts.modelPreference if they have a specific reason to want a cheaper SKU.
  const modelPreference = opts.modelPreference ?? "claude46sonnetthinking";

  // Cache lookup. Pro queries get a short TTL (5 min) so accidental same-turn
  // duplicates don't pay the network round-trip; concise queries get the full
  // heuristic TTL window.
  const cacheKeyHash = hashQuery({
    query: opts.query,
    mode,
    modelPreference,
    language,
  });
  const cached = await convex.query(api.perplexity.getCachedResult, {
    queryHash: cacheKeyHash,
  });
  if (cached) {
    void convex.mutation(api.perplexity.recordCacheHit, { queryHash: cacheKeyHash });
    try {
      const parsed = JSON.parse(cached) as PerplexitySearchResult;
      return { ...parsed, fromCache: true };
    } catch (err) {
      console.warn("[perplexity] cache row parse failed, ignoring", err);
    }
  }

  return new Promise<PerplexitySearchResult>((resolve, reject) => {
    queue.push(() =>
      doSearch({ ...opts, mode, language, modelPreference }, cacheKeyHash).then(
        resolve,
        reject,
      ),
    );
    if (!processing) {
      void drainQueue();
    }
  });
}

async function drainQueue(): Promise<void> {
  processing = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) break;
      try {
        await job();
      } catch (err) {
        // Job already rejected its caller's promise; just keep draining so
        // other queued queries don't get stuck behind this one.
        console.error("[perplexity] queue job failed:", err);
      }
      // 16–24s jitter between requests — emulates a real Pro user reading
      // an answer before typing the next prompt. The previous 1–4s spacing
      // burned through cookie reputation faster than the natural pacing of a
      // human research session, even on a residential IP. With ADR (one Pro
      // Search + 0–3 follow-ups per spawn), 16–24s puts each spawn's full
      // pipeline in the 1–2 minute range — still snappy for the user, but
      // pattern-detection-friendly.
      //
      // NOTE: this is a queue-global pause, applied between any two queued
      // jobs regardless of which spawn / conversation they belong to. With a
      // single primary user that's effectively "within same spawn". For
      // multi-user fan-out we'd want to track per-spawn last-call timestamps
      // and only delay back-to-back calls from the same caller.
      if (queue.length > 0) {
        await sleep(16000 + Math.random() * 8000);
      }
    }
  } finally {
    processing = false;
  }
}

interface InternalSearchOptions {
  query: string;
  mode: PerplexityMode;
  modelPreference: string;
  language: string;
  conversationId?: string;
  signal?: AbortSignal;
}

async function doSearch(
  opts: InternalSearchOptions,
  cacheKeyHash: string,
): Promise<PerplexitySearchResult> {
  const state = await convex.query(api.perplexity.getState, {});
  if (!state) {
    throw new Error(
      "[perplexity] no cookies in Convex — run `npm run refresh-perplexity-cookies -- --profile-id=<id>` to seed them",
    );
  }
  if (!state.cookies) {
    throw new Error("[perplexity] cookies field is empty in perplexityState");
  }

  const dispatcher = getDispatcher();
  if (!dispatcher) {
    throw new Error("[perplexity] PERPLEXITY_PROXY_URL not set — refusing to call Perplexity from a data-center IP");
  }

  const session = opts.conversationId
    ? await convex.query(api.perplexity.getSession, {
        conversationId: opts.conversationId,
      })
    : null;

  const body = {
    query_str: opts.query,
    params: {
      attachments: [],
      frontend_context_uuid: randomUUID(),
      frontend_uuid: randomUUID(),
      is_incognito: false,
      language: opts.language,
      last_backend_uuid: session?.backendUuid ?? null,
      // "copilot" is Perplexity's internal name for what the UI calls "Pro
      // Search". `concise` skips the multi-step reasoning loop.
      mode: opts.mode === "pro" ? "copilot" : "concise",
      model_preference: opts.modelPreference,
      source: "default",
      sources: ["web"],
      // CRITICAL: without `search_focus: "internet"` Perplexity routes the
      // query through "writing" mode where it still searches but instructs
      // the model to ignore search results — the model then says "I cannot
      // access real-time data" while web_results sit unused in the response.
      search_focus: "internet",
      search_recency_filter: null,
      timezone: state.timezone ?? "UTC",
      visitor_id: randomUUID(),
      user_nextauth_id: randomUUID(),
      prompt_source: "user",
      query_source: "home",
      browser_history_summary: [],
      is_related_query: false,
      is_sponsored: false,
      is_nav_suggestions_disabled: false,
      use_schematized_api: true,
      send_back_text_in_streaming_api: false,
      supported_block_use_cases: DEFAULT_SUPPORTED_BLOCKS,
      client_coordinates: null,
      version: "2.18",
    },
  };

  const userAgent = state.userAgent || DEFAULT_USER_AGENT;
  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    "sec-ch-ua": '"Chromium";v="130", "Not?A_Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Linux"',
    accept: "text/event-stream",
    "accept-language": "en-US,en;q=0.9",
    "content-type": "application/json",
    origin: "https://www.perplexity.ai",
    referer: "https://www.perplexity.ai/",
    cookie: state.cookies,
  };

  // First-pass: plain undici fetch over the residential proxy. If we ever
  // start seeing systematic Cloudflare 403s on this path, set
  // `PERPLEXITY_USE_CYCLETLS=1` in the env and the optional cycletls hook
  // below kicks in (Chrome JA3 impersonation). The hook stays out of the
  // happy-path so installs without cycletls keep building.
  let resp: { status: number; body: ReadableStream<Uint8Array> | null; text: () => Promise<string> };
  if (process.env.PERPLEXITY_USE_CYCLETLS === "1") {
    resp = await cycletlsFetch({
      url: PERPLEXITY_URL,
      method: "POST",
      headers,
      body: JSON.stringify(body),
      proxyUrl: process.env.PERPLEXITY_PROXY_URL!,
      signal: opts.signal,
    });
  } else {
    const r = await undiciFetch(PERPLEXITY_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      dispatcher,
      signal: opts.signal,
    });
    resp = {
      status: r.status,
      body: r.body as ReadableStream<Uint8Array> | null,
      text: () => r.text(),
    };
  }

  if (resp.status === 401 || resp.status === 403) {
    // Drain the body so the proxy connection returns to the pool. Critical
    // when cookies have expired — every queued search will hit this branch
    // until refreshed, and an undrained body holds the underlying TCP
    // socket open in undici's pool.
    void resp.text().catch(() => undefined);
    const errorMsg = `HTTP ${resp.status} — cookies expired or Cloudflare challenge`;
    await convex.mutation(api.perplexity.recordFailure, { error: errorMsg });
    // Best-effort alert on the way out so the user notices before the next
    // search blocks. Don't block the search-error rejection on the alert.
    // Cooldown is enforced inside maybeNotifyCookiesExpired so a flood of
    // queued failures coalesces into one Telegram ping per hour.
    void maybeNotifyCookiesExpired(errorMsg);
    throw new Error(`[perplexity] ${errorMsg}`);
  }
  if (resp.status === 429) {
    void resp.text().catch(() => undefined);
    const errorMsg = "HTTP 429 — Pro Search rate limit hit";
    await convex.mutation(api.perplexity.recordFailure, { error: errorMsg });
    throw new Error(`[perplexity] ${errorMsg}`);
  }
  if (resp.status >= 500) {
    const text = await resp.text();
    const errorMsg = `HTTP ${resp.status}: ${text.slice(0, 300)}`;
    await convex.mutation(api.perplexity.recordFailure, { error: errorMsg });
    throw new Error(`[perplexity] ${errorMsg}`);
  }
  if (resp.status !== 200) {
    const text = await resp.text();
    const errorMsg = `HTTP ${resp.status}: ${text.slice(0, 300)}`;
    await convex.mutation(api.perplexity.recordFailure, { error: errorMsg });
    throw new Error(`[perplexity] ${errorMsg}`);
  }
  if (!resp.body) {
    throw new Error("[perplexity] no response body on 200 OK");
  }

  const parsed = await parseSseStream(resp.body, opts.modelPreference);

  await convex.mutation(api.perplexity.recordSuccess, {});

  if (opts.conversationId && parsed.backendUuid) {
    await convex.mutation(api.perplexity.setSession, {
      conversationId: opts.conversationId,
      backendUuid: parsed.backendUuid,
    });
  }

  // Cache the result. Pro mode gets PRO_TTL_MS, concise gets the heuristic TTL.
  const ttlMs = cacheTtlMs(opts.query, opts.mode);
  if (ttlMs > 0) {
    await convex.mutation(api.perplexity.cacheResult, {
      queryHash: cacheKeyHash,
      query: opts.query,
      mode: opts.mode,
      result: JSON.stringify(parsed),
      ttlMs,
    });
  }

  return parsed;
}

// ---------- SSE parsing ----------

interface RawWebResult {
  url?: string;
  name?: string;
  title?: string;
  snippet?: string;
}

interface RawBlock {
  intended_usage?: string;
  markdown_block?: {
    chunks?: string[];
    progress?: string;
  };
  web_result_block?: {
    web_results?: RawWebResult[];
  };
  plan_block?: {
    steps?: Array<{ step_type?: string; goal?: string; description?: string }>;
    goals?: string[];
  };
}

interface RawEvent {
  backend_uuid?: string;
  web_results?: RawWebResult[];
  blocks?: RawBlock[];
}

async function parseSseStream(
  body: ReadableStream<Uint8Array>,
  model: string,
): Promise<PerplexitySearchResult> {
  const decoder = new TextDecoder("utf-8");
  const reader = body.getReader();

  let buffer = "";
  let lastMarkdown = "";
  let backendUuid: string | undefined;
  const sources = new Map<string, PerplexitySource>();
  const thinking: string[] = [];

  const flushEvents = (raw: string) => {
    // Each SSE event is separated by a blank line ("\r\n\r\n" or "\n\n"). A
    // single event spans one or more lines like:
    //   event: message
    //   data: {...json...}
    const events = raw.split(/\r?\n\r?\n/);
    // Last fragment may be partial — keep it back in the buffer.
    buffer = events.pop() ?? "";
    for (const ev of events) {
      const dataLines = ev
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      if (dataLines.length === 0) continue;
      const dataStr = dataLines.join("");
      if (!dataStr || dataStr === "[DONE]") continue;
      let parsed: RawEvent;
      try {
        parsed = JSON.parse(dataStr) as RawEvent;
      } catch {
        // Defensive — Perplexity occasionally injects non-JSON keepalives.
        continue;
      }
      if (parsed.backend_uuid) backendUuid = parsed.backend_uuid;
      if (Array.isArray(parsed.web_results)) {
        for (const r of parsed.web_results) collectSource(sources, r);
      }
      if (Array.isArray(parsed.blocks)) {
        for (const block of parsed.blocks) {
          const usage = block.intended_usage;
          if (usage === "web_results" && block.web_result_block?.web_results) {
            for (const r of block.web_result_block.web_results) {
              collectSource(sources, r);
            }
          } else if (usage === "markdown" && block.markdown_block) {
            const chunks = block.markdown_block.chunks ?? [];
            // chunks is a cumulative full-text snapshot, not a delta — we
            // overwrite the previous accumulator each time.
            if (chunks.length > 0) {
              lastMarkdown = chunks.join("");
            }
          } else if (
            usage === "pro_search_steps" &&
            Array.isArray(block.plan_block?.steps)
          ) {
            for (const step of block.plan_block!.steps!) {
              const label = step.description ?? step.goal;
              if (label) thinking.push(`${step.step_type ?? "STEP"}: ${label}`);
            }
          } else if (usage === "plan" && Array.isArray(block.plan_block?.goals)) {
            for (const goal of block.plan_block!.goals!) {
              if (goal) thinking.push(`PLAN: ${goal}`);
            }
          }
        }
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    flushEvents(buffer);
  }
  // Flush any final buffered fragment without trailing blank line.
  if (buffer.trim()) {
    flushEvents(buffer + "\n\n");
  }

  return {
    answer: cleanResponse(lastMarkdown),
    sources: [...sources.values()],
    thinkingSteps: thinking,
    model,
    backendUuid,
  };
}

function collectSource(map: Map<string, PerplexitySource>, raw: RawWebResult): void {
  if (!raw.url) return;
  const title = raw.title ?? raw.name ?? raw.url;
  if (!map.has(raw.url)) {
    map.set(raw.url, { url: raw.url, title, snippet: raw.snippet });
  }
}

// Mirrors the cleanup pipeline from jamie950315/pplx-proxy:
//   - strips XML declarations and orphan grok/script/response tags Perplexity
//     occasionally leaks into markdown_block chunks
//   - drops the inline `[1]`, `[2]` citation markers (we attach a Sources
//     section separately so numeric markers add no information)
//   - collapses redundant whitespace
function cleanResponse(text: string): string {
  return text
    .replace(/<\?xml[^?]*\?>/g, "")
    .replace(/\[\d+\]/g, "")
    .replace(/<grok:[^>]*>[\s\S]*?<\/grok:[^>]*>/g, "")
    .replace(/<grok:[^>]*\/>/g, "")
    .replace(/<\/?response[^>]*>/g, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<\/?script[^>]*>/g, "")
    .replace(/ {2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------- Optional cycletls fallback ----------

interface CycletlsRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  proxyUrl: string;
  signal?: AbortSignal;
}

interface CycletlsResponse {
  status: number;
  body: ReadableStream<Uint8Array> | null;
  text: () => Promise<string>;
}

// Lazy-loaded so installs without cycletls don't break. Triggered only when
// PERPLEXITY_USE_CYCLETLS=1 — in normal operation undici's fetch is enough.
async function cycletlsFetch(req: CycletlsRequest): Promise<CycletlsResponse> {
  let mod: { default?: unknown } | unknown;
  try {
    mod = await import("cycletls");
  } catch (err) {
    throw new Error(
      "[perplexity] PERPLEXITY_USE_CYCLETLS=1 but cycletls is not installed. Run `npm install cycletls` and retry.",
    );
  }
  // We deliberately avoid hard-typing the cycletls API here — its surface
  // (especially around streaming bodies) is unstable across versions. The
  // non-streaming path is sufficient for the fallback because cycletls is
  // only invoked when we expect Cloudflare to gate us anyway.
  type CycletlsLib = (
    url: string,
    opts: Record<string, unknown>,
    method: string,
  ) => Promise<{ status: number; body: string }>;
  const cycletlsImport = mod as { default?: { default?: CycletlsLib } | CycletlsLib };
  const fnLayerOne = cycletlsImport.default;
  const fnLayerTwo =
    fnLayerOne && typeof fnLayerOne === "object" && "default" in fnLayerOne
      ? (fnLayerOne.default as CycletlsLib)
      : (fnLayerOne as CycletlsLib);
  const fn = fnLayerTwo;
  const out = await fn(
    req.url,
    {
      body: req.body,
      headers: req.headers,
      ja3: "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513-21,29-23-24,0",
      userAgent: req.headers["User-Agent"] ?? DEFAULT_USER_AGENT,
      proxy: req.proxyUrl,
      timeout: 60000,
    },
    req.method,
  );
  // cycletls' non-streaming response body is a string; wrap into a
  // ReadableStream so the rest of the parser pipeline doesn't care which
  // path produced the bytes.
  const encoder = new TextEncoder();
  const bytes = encoder.encode(out.body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return {
    status: out.status,
    body: stream,
    text: async () => out.body,
  };
}

// ---------- Health check / keep-alive ----------

export async function checkPerplexitySession(): Promise<{
  ok: boolean;
  status: number;
}> {
  const state = await convex.query(api.perplexity.getState, {});
  if (!state) return { ok: false, status: 0 };
  const dispatcher = getDispatcher();
  if (!dispatcher) return { ok: false, status: 0 };
  const resp = await undiciFetch(KEEPALIVE_URL, {
    method: "GET",
    headers: {
      "User-Agent": state.userAgent || DEFAULT_USER_AGENT,
      cookie: state.cookies,
    },
    dispatcher,
  });
  // Drain the body so the connection can be returned to the pool.
  void resp.text().catch(() => undefined);
  return { ok: resp.status === 200, status: resp.status };
}

// Telegram alert helper. Dynamic-imported to avoid a circular dep with
// telegram.ts (telegram.ts imports interaction-agent.ts which transitively
// reaches integrations).
//
// Cooldown is shared between the two callers — search-time 401/403 and the
// keep-alive loop — so a single cookie outage doesn't trip alerts from both
// sources within the same hour. The state lives at module scope here
// because perplexity-keep-alive imports this helper (already depends on
// adminChatIdOrFallback / checkPerplexitySession).
let lastCookieAlertAt = 0;
const COOKIE_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1h

export async function maybeNotifyCookiesExpired(reason: string): Promise<void> {
  const now = Date.now();
  if (now - lastCookieAlertAt < COOKIE_ALERT_COOLDOWN_MS) return;
  const adminChatId = adminChatIdOrFallback();
  if (!adminChatId) {
    console.warn(
      "[perplexity] cookies-expired alert skipped — TELEGRAM_ADMIN_CHAT_ID not set and TELEGRAM_ALLOWED_CHAT_IDS empty",
    );
    return;
  }
  try {
    const { sendTelegramMessage } = await import("./telegram.js");
    await sendTelegramMessage(
      adminChatId,
      `⚠️ Perplexity cookies expired (${reason}).\nRun \`npm run refresh-perplexity-cookies -- --profile-id=<id>\` to update.`,
    );
    lastCookieAlertAt = now;
  } catch (err) {
    console.error("[perplexity] failed to send cookies-expired alert:", err);
  }
}

export function adminChatIdOrFallback(): string | null {
  const explicit = process.env.TELEGRAM_ADMIN_CHAT_ID?.trim();
  if (explicit) return explicit;
  const allowed = (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed[0] ?? null;
}
