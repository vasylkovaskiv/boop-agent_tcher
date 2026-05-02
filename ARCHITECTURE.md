# Architecture

boop-agent is a small distributed system disguised as a single-server app. Four moving parts, each doing one job.

## The four parts

```
┌────────────────────────────────────────────────────────────────┐
│                      EXPRESS + WS SERVER                        │
│                                                                 │
│   Telegram (poll OR webhook) ────►  Interaction Agent           │
│   POST /chat                        (dispatcher, streams)       │
│   WS /ws                                  │                     │
│                                           │ spawn_agent         │
│                                           ▼                     │
│                                    Execution Agent(s)           │
│                                    (one per task)               │
│                                           │                     │
│                                           ▼                     │
│                                    Integrations (MCP)           │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                       ┌────────────┐         ┌────────────────┐
                       │  Convex    │◄───────►│  Debug UI      │
                       │  (truth)   │         │  (read-only)   │
                       └────────────┘         └────────────────┘
```

### 1. Interaction agent — `server/interaction-agent.ts`

The front door. One instance per user turn. Its job is to **decide**, not to do.

- Reads the user's message + last 10 turns from Convex.
- Has three tools via two MCP servers it owns:
  - `boop-memory.recall(query)` — pull relevant memories.
  - `boop-memory.write_memory(content, segment, importance, tier?)` — persist a durable fact.
  - `boop-spawn.spawn_agent(task, integrations[], name?)` — kick off an execution agent.
- Its system prompt drills the DISPATCHER rule: answer directly for chit-chat, spawn an agent for real work.
- Replies stream out through Telegram (markdown stripped, chunked to 4000 chars; Telegram caps at 4096).

### 2. Execution agent — `server/execution-agent.ts`

Spawned per task. Ephemeral. One instance, one job, one result.

- Gets the specific `task` the interaction agent wrote (not the raw user message).
- Loads **only** the integrations named in the spawn call.
- System prompt drills: Telegram-friendly output, draft-before-send for any external action.
- Logs every `tool_use`, `tool_result`, and text block to Convex so the debug dashboard can replay it.
- Runs with `permissionMode: bypassPermissions` — the interaction agent is the gatekeeper.
- Returns a string. That string becomes a tool-result back to the interaction agent, which rewrites it in its own voice.

### 3. Memory — `server/memory/`

Three files, three jobs.

**`types.ts`** — shape + defaults.
- Tiers: `short` (decay 5%/day), `long` (2%/day), `permanent` (no decay).
- Segments: `identity`, `preference`, `relationship`, `project`, `knowledge`, `context`.

**`tools.ts`** — the `boop-memory` MCP server. `recall` and `write_memory`. Each call emits a `memoryEvents` row so you can watch it live in the dashboard.

**`extract.ts`** — fires post-turn, **fire-and-forget**. Sends `(userMsg, assistantReply)` to a Claude pass (uses `BOOP_MODEL`, default `claude-haiku-4-5-20251001`) with an extraction prompt, parses JSON facts, writes each one. The model is told to prefer fewer, higher-quality facts over many trivial ones. Same Anthropic-format endpoint as the dispatcher — routes through AgentRouter, direct Anthropic, or Claude Code subscription depending on env config (see section 8 "Model routing" below).

**`clean.ts`** — the memory-cleaning loop. Every 6 hours (configurable):


1. Load active memories.
2. Compute an effective score: `importance × decay × reinforcement`.
   - `decay = max(0, 1 − decayRate × daysSinceAccess)`
   - `reinforcement = 1 + log(1 + accessCount) × 0.1`
3. Below threshold `0.15` → archive. Below `0.05` → prune. Permanent memories are skipped.

This is deliberately simple. Everything sophisticated (consolidation, adversary/judge debates, knowledge graphs, embeddings) was stripped out. Add them back if you need them — the hooks are already in the Convex schema.

### 4. Automations — `server/automations.ts` + `server/automation-tools.ts`

The agent can schedule recurring work from any conversation. When the user says *"every morning at 8 summarize my calendar"*, the interaction agent calls `create_automation(name, cronExpr, task, integrations)`.

How it runs:
- **`server/automations.ts`** starts a 30-second poll (`startAutomationLoop`) when the server boots.
- On each tick it loads enabled automations from Convex, finds ones whose `nextRunAt` is ≤ now, and fires each one in parallel.
- Firing = `spawnExecutionAgent({ task, integrations, conversationId, name: "auto:..." })` — the same sub-agent system the interaction agent uses.
- The result is written as an `automationRun` row, and (if `notifyConversationId` points at a `tg:<chat_id>` conversation) pushed back out via Telegram so the user sees it in their bot chat.
- `nextRunAt` is recomputed with `croner` and stored.

The four MCP tools exposed to the interaction agent (`server/automation-tools.ts`):
- `create_automation(name, schedule, task, integrations, notify?)`
- `list_automations(enabledOnly?)`
- `toggle_automation(id, enabled)`
- `delete_automation(id)`

Schedule is a standard 5-field cron expression. Croner also understands extended syntax (timezones, seconds) if you want to upgrade the tool description.

### 5. Drafts — `server/draft-tools.ts`

Any external action (send email, create event, post Slack message) is staged, not committed, by the execution agent.

- Execution agents only have `save_draft(kind, summary, payload)`. The "real" send tools exist in each integration but the system prompt routes agents through `save_draft` first.
- The interaction agent has `list_drafts`, `send_draft(draftId, integrations)`, `reject_draft(draftId)`.
- `send_draft` spawns a new execution agent with the stored payload as its task. This is the only path to actually committing an action.

You can see every draft (pending, sent, rejected) in the Drafts tab of the debug dashboard, including the raw JSON payload.

### 6. Heartbeat + lifecycle — `server/heartbeat.ts`

Every 60 seconds, scan `executionAgents` with status `running`. Any whose `startedAt` is older than 15 minutes gets marked `failed` and the in-process `AbortController` is triggered if it still exists. This handles both server restarts (controller gone, DB still "running") and genuinely stuck agents.

HTTP routes for the debug dashboard:
- `POST /agents/:id/cancel` — abort an in-flight agent
- `POST /agents/:id/retry` — re-spawn an agent with the same task + integrations

### 7. Consolidation — `server/consolidation.ts`

Runs daily (or on-demand). A **three-agent adversarial pipeline** over the active memory set, deliberately routing different stages to different model families to avoid echo-chamber agreement:

1. **Proposer** — model: `BOOP_MODEL` (Claude family). Receives the full memory list and returns proposals:
   - `merge` — combine several entries into one rewrite
   - `supersede` — newer memory replaces older on a conflicting value
   - `prune` — remove redundant or wrong entries
2. **Adversary** — model: `BOOP_ADVERSARY_MODEL` (defaults to `glm-5.1` when `AGENTROUTER_API_KEY` is set, else falls back to a **hardcoded** `claude-haiku-4-5-20251001` — independent of `BOOP_MODEL`, so the adversary stays on a cheap second-opinion model even when the dispatcher is upgraded to sonnet/opus). A **different model family is the whole point** — a Claude challenging a Claude tends to politely agree; GLM-5.1 from a different lineage gives genuine objections. Receives the proposer's proposals + the original memory list and produces a `challenges[]` array with `{proposalIndex, severity, objection}`. **No fallback on AgentRouter outage** — if the OpenAI-compat call fails, the entire consolidation run is aborted (and retried tomorrow). Wasting one proposer/judge pair (~$0.04 of haiku tokens) is preferable to silently degrading the adversary into a same-family yes-man.
3. **Judge** — model: `BOOP_MODEL` (Claude family). Receives proposals + adversary challenges + originals, decides per-proposal `{approve: bool, rationale: string}`.
4. Approved proposals are applied via `supersedes` on `memoryRecords` (which archives the superseded memories automatically in the upsert mutation).

Keeps memory sharper over time instead of noisier. The full run is logged in `consolidationRuns`. Both the OpenAI-compat path (adversary on GLM) and the Anthropic-format path (proposer/judge on Claude) flow through `runLlm()` in `consolidation.ts`, which dispatches via `isOpenAICompatModel(model)` — see section 8 "Model routing" below for the full picture.

### 8. Model routing — `server/runtime-config.ts` + `server/llm.ts`

Boop talks to LLMs via two completely separate transport stacks. They don't share clients, base URLs, or auth headers — only the choice of model decides which one a call goes through.

```
┌────────────────────────────────────────────────────────────────────────┐
│ Anthropic Messages format (MCP, prompt caching, tool_use blocks)        │
│ Used by: interaction-agent · execution-agent · memory/extract ·         │
│          consolidation Proposer · consolidation Judge                    │
│ Client:  @anthropic-ai/claude-agent-sdk's query()                       │
│ Auth:    ANTHROPIC_API_KEY (direct) OR                                  │
│          ANTHROPIC_BASE_URL=https://agentrouter.org/                    │
│           + ANTHROPIC_AUTH_TOKEN (proxied) OR                           │
│          Claude Code session credentials on disk                        │
│ Models:  claude-haiku-4-5-20251001 (default), claude-sonnet-4-6,        │
│          claude-opus-4-6, claude-opus-4-7                               │
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│ OpenAI-compat format (no MCP, plain chat completions)                   │
│ Used by: proactive-email classifier · consolidation Adversary           │
│ Client:  openai SDK (server/llm.ts → callOpenAILLM)                     │
│ Auth:    AGENTROUTER_API_KEY + AGENTROUTER_BASE_URL                     │
│ Models:  glm-5.1 (default for both call sites)                          │
│          (the OpenAI-compat path is also where you'd add gpt-*,         │
│           deepseek, qwen, etc. if you wanted them)                      │
└────────────────────────────────────────────────────────────────────────┘
```

**Why two stacks at all?** The Claude Agent SDK only speaks Anthropic Messages format (MCP tool calls, `tool_use`/`tool_result` blocks, prompt caching all live in that format). GLM-5.1 doesn't speak Anthropic Messages — it speaks OpenAI Chat Completions. We could insert a proxy like LiteLLM to translate, but the lossy tool-call mapping and lost prompt caching make it a worse trade than just using the OpenAI client directly for the few calls that benefit from a non-Claude model.

**`server/runtime-config.ts`** owns the dispatcher-side choice. `getRuntimeModel()` checks the Convex `settings` table first (so the in-bot `set_model` self-tool can override per-user-per-conversation), then falls back to `BOOP_MODEL`, then to the hardcoded default `claude-haiku-4-5-20251001`. `MODEL_ALIASES` lets the user say "use opus" or "switch to sonnet" — `resolveModelInput()` maps those to canonical model ids.

**`server/llm.ts`** owns the OpenAI-compat client. It exports `callOpenAILLM({ model, systemPrompt, userPrompt, maxTokens? })` which:
- POSTs to `${AGENTROUTER_BASE_URL}/chat/completions` with `Authorization: Bearer ${AGENTROUTER_API_KEY}`.
- Maps the response's `usage.prompt_tokens` / `completion_tokens` into the same `UsageTotals` shape the Anthropic path produces, computing `costUsd` from the `PRICING_PER_M` table at the top of the file.
- Returns `{ text, usage, durationMs }`.

`isOpenAICompatModel(model: string): boolean` is the dispatch primitive. Both `consolidation.ts:runLlm()` and `proactive-email.ts` call it to decide whether to send a request through `callOpenAILLM` (OpenAI path) or through the Claude Agent SDK's `query()` (Anthropic path).

**Failure modes are deliberately different per call site:**

| Call site | On AgentRouter outage | Why |
|---|---|---|
| Email classifier | catch + log + retry on `claude-haiku-4-5-20251001` (Anthropic path) | A missed classification = a missed proactive notification to the user. We'd rather pay the haiku premium and still tell them about an important email. |
| Consolidation Adversary | fail the entire run, retry tomorrow | The adversary's whole purpose is to be a different family from proposer/judge. Falling back to haiku turns it into a Claude challenging a Claude — defeats the point. The cost of one skipped daily run (~$0.04 of wasted proposer/judge tokens) is negligible. |

See `server/proactive-email.ts:236-257` for the classifier fallback wrapper, and `server/consolidation.ts:125-140` for the adversary's no-fallback dispatch.

**Cost recording.** `callOpenAILLM()` (in `server/llm.ts`) and `aggregateUsageFromResult()` (in `server/usage.ts`) produce structurally identical `UsageTotals` rows. The OpenAI path computes `costUsd` from `PRICING_PER_M[model]` at the top of `llm.ts`; the Anthropic path takes the SDK-reported `total_cost_usd` from the `result` message (authoritative against Anthropic's billing). Both flow into the same `usageRecords` Convex table (`source: "dispatcher"` / `"execution"` / `"classifier"` / `"consolidation-proposer"` / `"consolidation-adversary"` / `"consolidation-judge"` / `"memory-extract"`), so the Dashboard tab's spend tile sees one unified picture across both transport stacks.

### 9. Streaming — `server/telegram-stream.ts`

Replies stream live via Telegram's native `sendMessageDraft` API (Bot API 9.5+, March 2026). The dispatcher pushes incremental text chunks at `DEBOUNCE_MS=800` intervals with a `MIN_INTERVAL_MS=1000` floor between frames (Telegram throttles editMessage-style updates below ~1s); the user sees text appear progressively as the model writes — no notification on the first frame, no "edited" tag on the final commit.

```
interaction-agent.ts:
  stream = createDraftStream(chatId)  // private chat only, else noopStream
  for await (msg of query(...)) {
    if (msg is text delta) stream.push(deltaText)
    if (msg is new turn) stream.reset()  // pre-tool narration vs final reply
  }
  await stream.finalize(reply)  // sendMessage commits the draft
```

Key contract:
- **`push(text)`**: appends to internal buffer, schedules a Telegram `sendMessageDraft` if no pending timer.
- **`reset()`**: clears the buffer between turns so pre-tool acks ("Сейчас, секунду…") don't bleed into the final reply.
- **`finalize(text)`**: cancels pending timer, sends `text` via plain `sendMessage` (which commits over the latest draft). **Always sends if not yet finalized**, even after `abort()` was called — this is intentional, motivated by an earlier silent-drop bug where the dispatcher's catch path called `abort()` then expected `finalize()` to deliver the error reply.
- **`abort()`**: stops new draft frames. Does NOT prevent a subsequent `finalize()` from committing — abort is for clean cancellation of in-flight chunks, not for suppressing the final reply.

Disabled paths (always single-shot via `noopStream`):
- Group chats (Telegram API doesn't allow `sendMessageDraft` for groups).
- Proactive turns (no inbound user message to respond to).
- `TELEGRAM_STREAMING=false` env override.
- Bot clients older than Bot API 9.5 — `sendMessageDraft` returns 400, swallowed; `finalize()` falls back to plain `sendMessage`.

The streaming module is independent of the model routing module — it doesn't care whether tokens came from haiku-via-AgentRouter or sonnet-via-direct-Anthropic. It just consumes the dispatcher's output stream.

### 10. Integrations — Composio (`server/composio.ts`)

Boop delegates all third-party integrations to [Composio](https://composio.dev/?utm_source=chris&utm_medium=youtube&utm_campaign=collab). One SDK, 1000+ toolkits, hosted auth.

Flow:
1. User clicks **Connect** on a toolkit card in the debug dashboard's Connections tab.
2. Frontend → `POST /composio/toolkits/:slug/authorize` → backend calls `session.authorize(slug)` and returns Composio's hosted `redirectUrl`.
3. Popup opens the redirect URL. User authenticates. Composio stores the tokens on its side.
4. Popup closes → frontend calls `POST /composio/refresh` → backend re-runs `registerComposioToolkits()` which iterates `connectedAccounts.list({ userIds: [boopUserId()] })` and registers each active toolkit as an `IntegrationModule` keyed by its slug.
5. `availableIntegrations()` now includes the new slug, so the dispatcher can spawn a sub-agent with it.

On each spawn, `buildComposioIntegrationModule(slug).createServer()` opens a **fresh toolkit-scoped Composio session**:

```ts
await composio.create(boopUserId(), {
  toolkits: [slug],            // scope — sub-agent only sees this toolkit's tools
  manageConnections: false,    // don't inject auth-management meta-tools
});
```

and returns an `McpSdkServerConfigWithInstance` via `createSdkMcpServer`. The sub-agent never sees the full Composio catalog — only the tools for the toolkits the dispatcher asked for.

HTTP routes (`server/composio-routes.ts`, mounted at `/composio`):
- `GET  /status` — `{ enabled }`.
- `GET  /toolkits` — curated list merged with current connection state.
- `POST /toolkits/:slug/authorize` — returns `{ redirectUrl, connectionId }`.
- `POST /toolkits/:slug/disconnect` — revokes + refreshes registry.
- `POST /refresh` — re-runs the registry loader.

Env:
- `COMPOSIO_API_KEY` — required for integrations. Without it, plain chat + memory + automations still work.
- `COMPOSIO_USER_ID` — optional; defaults to `boop-default` for single-tenant use.

### 11. Integrations — Perplexity Pro Search (`server/perplexity*.ts`)

Reverse-engineered Perplexity Pro Search integration sitting alongside the Composio path. Loaded in the same `loadIntegrations()` pass, gated on `PERPLEXITY_PROXY_URL` being set (without a residential proxy Cloudflare reliably 403s the search endpoint and burns the cookies; better to no-op).

Routing — how the worker decides to call this tool in the first place:
- `server/execution-agent.ts` exposes `buildExecutionSystem(integrations)` which appends the loaded integrations + their descriptions onto the worker's system prompt and biases the "Research discipline" section toward `mcp__perplexity__perplexity_search` for multi-source synthesis / current events / explicit "Pro Search" requests, with `WebSearch` reserved for simple fact lookups and `WebFetch` for known URLs.
- `.claude/skills/web-research/SKILL.md` (mirrored to `.agents/skills/`) holds the more detailed decision tree the worker can consult via the `Skill` tool when the prompt heuristic isn't conclusive.

Flow on a search:
1. Worker calls `mcp__perplexity__perplexity_search({ query, mode? })`.
2. `perplexitySearch()` SHA-256s the (mode + model + language + query) tuple, looks it up in `perplexityCache` — Pro queries get a 5-minute TTL (dedup same-turn duplicates), concise gets a 1h–24h heuristic TTL.
3. On a miss, the request is enqueued (sequential FIFO with 1–4s jitter — parallel requests on the same cookie pair are a fast path to a ban).
4. The job pulls cookies + `userAgent` from the singleton `perplexityState` row, looks up `last_backend_uuid` from `perplexitySessions` (per-conversation, expires after 55 min), and POSTs to `/rest/sse/perplexity_ask` through the residential proxy (undici `ProxyAgent` for HTTP/HTTPS proxies, `Socks5ProxyAgent` for SOCKS5).
5. SSE stream is parsed for the cumulative `markdown_block` + the `web_result_block` sources + the `pro_search_steps` plan. The result is cached, the new `backend_uuid` is persisted as the conversation's session, and the worker gets back a markdown answer with a `**Sources:**` section that the dispatcher passes through verbatim.

Health:
- `server/perplexity-keep-alive.ts` runs a setTimeout loop (6h ± 30 min jitter) that hits `/api/auth/session` through the proxy. On 401/403 it sends a Telegram alert (`TELEGRAM_ADMIN_CHAT_ID`, falling back to first allowed chat id) with a 1h cooldown and increments `consecutiveFailures` in `perplexityState`.
- Cookie refresh is a human-driven step run from the user's local machine via `npm run refresh-perplexity-cookies -- --profile-id=<id>`. The script attaches `puppeteer-core` to a Dolphin Anty profile via the local CDP endpoint, extracts the cookie jar, verifies that `__Secure-next-auth.session-token` is present (without that exact cookie name Perplexity silently downgrades to free tier), then pushes everything to Convex via `api.perplexity.updateCookies`. **Dolphin Free plan caveat:** `automation=1` on Dolphin's Local API is paid-tier only; on Free, the script returns 401 and you have to fall back to manual export — install Cookie-Editor in the running Dolphin profile, export the cookie jar as JSON from `perplexity.ai`, and push it via `npx convex run perplexity:updateCookies '{"cookies": "...", "userAgent": "...", "timezone": "..."}'`. See `docs/PERPLEXITY_SETUP.md → Step 5b`.

Cloudflare fallback:
- The happy path is plain undici fetch through the proxy. If TLS-fingerprinting becomes a problem, set `PERPLEXITY_USE_CYCLETLS=1` and `npm install cycletls`. The client lazy-imports cycletls only when the flag is on, so installs without it keep working.

Env:
- `PERPLEXITY_PROXY_URL` — required. Any residential proxy URL (HTTP/HTTPS or SOCKS5). Static residential preferred over rotating — cookie session is IP-bound. Disables the integration entirely when unset.
- `PERPLEXITY_TIMEZONE` — IANA timezone string, sent on every search to match the proxy's country.
- `TELEGRAM_ADMIN_CHAT_ID` — alert destination; falls back to first id in `TELEGRAM_ALLOWED_CHAT_IDS`.
- `PERPLEXITY_USE_CYCLETLS` — opt-in TLS fingerprint impersonation.

---

## Data model (Convex)

Read `convex/schema.ts` for the exact shape.

| Table | Role | Key fields |
|---|---|---|
| `messages` | Telegram + chat transcript | conversationId, role, content, turnId |
| `conversations` | Per-thread metadata | conversationId, messageCount, lastActivityAt |
| `memoryRecords` | The memory store | memoryId, content, tier, segment, importance, decayRate, accessCount, lifecycle, supersedes |
| `executionAgents` | One row per spawned agent | agentId, task, status, tokens, cost |
| `agentLogs` | Per-agent audit trail | agentId, logType, toolName, accounts, content |
| `automations` | Scheduled recurring tasks | automationId, schedule, task, integrations, enabled, nextRunAt |
| `automationRuns` | One row per automation run | runId, automationId, status, result, agentId |
| `drafts` | Staged external actions | draftId, kind, summary, payload, status |
| `consolidationRuns` | History of consolidation passes | runId, proposalsCount, mergedCount, prunedCount |
| `memoryEvents` | Append-only event log for the debug UI | eventType, conversationId, memoryId, data |
| `settings` | Runtime overrides (model, etc.) read by `server/runtime-config.ts` | key, value, updatedAt |
| `perplexityState` | Singleton — Perplexity Pro cookies + health | cookies, userAgent, timezone, lastSuccessAt, consecutiveFailures |
| `perplexityCache` | TTL'd query result cache | queryHash, query, mode, result, expiresAt, hits |
| `perplexitySessions` | Per-conversation `last_backend_uuid` for follow-ups | conversationId, backendUuid, lastUsedAt |

`memoryRecords` also carries a `vectorIndex("by_embedding")` with 1024-dimension vectors filtered by `lifecycle`.

Indexes are tight — search through the schema to see what's supported.

---

## Message lifecycle

Following a text from Telegram to reply, step by step:

```
1.  grammy receives an Update (long-poll or POST /telegram/webhook)
2.  telegram.ts:  in-memory dedup + chat-id allow-list + (voice→Whisper) → handleUserMessage()
3.  interaction-agent:  save user msg, fetch recent history
4.  interaction-agent:  query Claude with memory + spawn tools
     ↳ may call recall / write_memory
     ↳ may call spawn_agent → execution-agent runs, returns text
5.  interaction-agent:  final text → broadcast + return
6.  telegram.ts:  sendTelegramMessage() chunks + sends
7.  interaction-agent:  save assistant msg to Convex
8.  BACKGROUND: extract.ts pulls durable facts, writes memories
9.  LATER: clean.ts decays scores, archives or prunes
```

Steps 6–7 run in parallel where safe. Step 8 is fire-and-forget — the user never waits on extraction.

---

## Why this shape

**Dispatcher / executor split.** The interaction agent has a tiny toolset and a short prompt so it's cheap, fast, and deterministic. The execution agent gets heavy tools (MCPs) but only runs when needed. Most casual turns never spawn an agent — they complete in one interaction-agent call.

**Memory lives next to execution, not in the model.** Claude has no memory across turns. We re-hydrate the relevant slice every turn via `recall()`. Writing is explicit (`write_memory`) or inferred (`extract.ts`). Nothing is implicit.

**Integrations via Composio.** Tool-calling is what the SDK does best. Composio handles the OAuth, token-refresh, and 1000+ service adapters we'd otherwise hand-roll. Each connected toolkit becomes an MCP server on demand, scoped to just that toolkit so the sub-agent's context stays small.

**Convex for state.** Reactive queries power the debug UI without polling. Durable enough for real use, free tier generous enough for a personal agent.

---

## What's intentionally missing

- **No user auth.** This is a single-user tool. Add Clerk or similar if you want multi-tenant.
- **Single-process scheduler.** The automation loop runs in-process. If you deploy multiple instances, you'll double-fire — add a lock in Convex or run a dedicated scheduler pod.
- **No intelligence runs** (proactive context gathering) — the original had it, it's complex, and it's opinionated about what it watches. Add it if you want.
- **No knowledge graph** — relationships between memories are represented via `supersedes` only, not a full graph.
- **Skills library omitted** — too Boop-specific; write your own prompts/policies in `server/*-agent.ts` system prompts.

All of these are one-file additions. The point of the template is to give you the smallest surface that still actually works.
