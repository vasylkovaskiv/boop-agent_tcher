<p align="center">
  <img src="assets/boop.gif" alt="Boop" width="220" />
</p>

# Boop

A Telegram-based personal agent built on top of the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview), with optional voice transcription via a self-hosted Whisper sidecar.

📺 **Watch the original walkthrough:** [YouTube — How I built Boop](https://youtu.be/ZpmKjDDbqHs)
*(walkthrough is for the Sendblue/iMessage version; the architecture and dispatcher/executor split are unchanged — only the transport layer was swapped.)*

> **This is a starting point, not a finished product.**
> It's the architecture I built for my own personal agent, opened up as a template so you can take it, text-enable your own Claude, and extend it however you want. Integrations are plugged in via [Composio](https://composio.dev/?utm_source=chris&utm_medium=youtube&utm_campaign=collab) — drop in an API key and connect Gmail, Slack, GitHub, Linear, Notion, and ~1000 others straight from the debug dashboard.

```
 Telegram  →  bot (long-poll or webhook)  →  Interaction agent  →  Sub-agents (per task)
                          │                          │                    │
                          ▼                          ▼                    ▼
              Whisper sidecar (voice)         Memory store  ←──  Integrations (your MCP tools)
```

Built on:
- [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) — the loop, tool use, sub-agents, MCP
- [Composio](https://composio.dev/?utm_source=chris&utm_medium=youtube&utm_campaign=collab) — integrations layer. One API key = Gmail, Slack, GitHub, Linear, Notion, Stripe, Supabase, + ~1000 more with hosted OAuth
- [grammy](https://grammy.dev) — Telegram Bot API client
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper) — optional self-hosted speech-to-text for voice notes
- [Convex](https://convex.link/chrisraroque) — real-time database for memory, agents, drafts
- Your [Claude Code](https://claude.com/code?ref=chrisraroque) subscription — no separate Anthropic API key required

---

## What you get

- **Telegram in / Telegram out** via `grammy`, with typing indicators and in-memory update dedup. Long-polling by default — no public URL or TLS needed for local dev.
- **Voice notes (optional)** — point `WHISPER_URL` at the bundled Whisper sidecar (`whisper-service/`, FastAPI + faster-whisper) and Boop transcribes incoming voice messages before handing them to the agent. Falls back gracefully when Whisper is offline.
- **Dispatcher + workers** pattern: a lean interaction agent decides what to do, spawns focused sub-agents that actually do the work.
- **Pure dispatcher** — the interaction agent has only memory + spawn + automation + draft tools. Web access, files, and integrations are explicitly denied to it; sub-agents get `WebSearch` / `WebFetch` / the integrations.
- **Tiered memory** (short / long / permanent) with post-turn extraction, decay, and cleaning.
- **Vector search** for recall when you add an embeddings key (Voyage or OpenAI) — falls back to substring.
- **Memory consolidation** — a daily 3-phase adversarial pipeline (proposer → adversary → judge) that merges duplicates, resolves contradictions, and prunes noise. Proposer and judge on Sonnet; adversary on Haiku for cheap skepticism. Runs every 24h by default, also triggerable manually via `POST /consolidate`.
- **Automations** — the agent can schedule recurring work from a text ("every morning at 8 summarize my calendar") and push results back to Telegram.
- **Draft-and-send** — any external action stages a draft first; the agent only commits when the user confirms.
- **Heartbeat + retry** — stuck agents auto-fail, debug dashboard can retry.
- **Composio-powered integrations** — one API key unlocks 1000+ toolkits. Connect Gmail, Slack, GitHub, Linear, Notion, Drive, HubSpot, etc. with a click from the debug dashboard. Composio handles OAuth + token refresh.
- **Debug dashboard** (React + Vite) with a Boop mascot — Dashboard (spend + tokens + agent status), Agents (timeline + integration logos), Automations, Memory (table + force-directed graph), Events, Connections.
- **Convex** for persistence — real-time, typed, free tier.
- **Uses your Claude Code subscription** — no separate Anthropic API key required.
- **Docker Compose + Traefik recipe** — deploy to a VPS with isolated `boop-net` for Node↔Whisper, `traefik-public` only when you need HTTPS for Composio webhooks, and Telegram polling that needs no inbound ports at all.

<p align="center">
  <img src="assets/agents-view.jpg" alt="Agents view in the Boop debug dashboard" width="900" />
  <br>
  <sub><em>Agents tab — every spawned sub-agent with status, cost, tokens, turns, runtime, and the integrations it touched.</em></sub>
</p>

<p align="center">
  <img src="assets/automations.jpg" alt="Automations view in the Boop debug dashboard" width="900" />
  <br>
  <sub><em>Automations tab — schedule recurring jobs from a text ("every morning at 8 summarize my calendar") and watch them run.</em></sub>
</p>

<p align="center">
  <img src="assets/memory-graph.jpg" alt="Memory graph in the Boop debug dashboard" width="900" />
  <br>
  <sub><em>Memory tab — force-directed graph of clustered memories across short, long, and permanent tiers. Tabular view also available.</em></sub>
</p>

<p align="center">
  <img src="assets/connections.jpg" alt="Connections view in the Boop debug dashboard" width="900" />
  <br>
  <sub><em>Connections tab — pick from a curated catalog of Composio toolkits and connect with one click.</em></sub>
</p>

---

## What you'll need

You need accounts for these. Keep the tabs open — setup will ask for credentials from each.

| Service | Why | Free? |
|---|---|---|
| [Claude Code](https://claude.com/code?ref=chrisraroque) | Powers the agent. Install it, sign in once, the SDK uses your session. | Subscription required |
| [Telegram BotFather](https://t.me/BotFather) | Creates the bot token. Talk to `@BotFather`, send `/newbot`, copy the token. | Free |
| [@userinfobot](https://t.me/userinfobot) | Tells you your numeric Telegram chat id (used for the allow-list and proactive notices). | Free |
| [Convex](https://convex.link/chrisraroque) | Database + realtime. | Free tier is plenty |
| [Composio](https://composio.dev/?utm_source=chris&utm_medium=youtube&utm_campaign=collab) | Integrations — one API key unlocks ~1000 toolkits. Optional if you just want chat + memory + automations without third-party access. | Free tier covers personal use — `CHRISXCOMPOSIO` gives 1 month free on starter |
| ngrok / Cloudflare Tunnel (optional) | Only needed for **Composio webhook** (proactive Gmail) or **Telegram webhook mode**. Polling-mode Telegram needs neither. | Free tier works |

**Custom integrations welcome.** Composio covers the common catalog, but you're free to add your own MCP servers under `server/integrations/` and register them in `server/integrations/registry.ts` — the dispatcher treats them the same as Composio-backed ones (just named toolkits the execution agent can spawn against). Useful for in-house APIs, local tools, or anything Composio doesn't ship.

---

## Quickstart

```bash
# 1. Clone + install
git clone https://github.com/raroque/boop-agent.git
cd boop-agent
npm install

# 2. Install Claude Code (one-time, global) and sign in
npm install -g @anthropic-ai/claude-code
claude  # sign in, then Ctrl-C to exit

# 3. Create a Telegram bot
#    - Open https://t.me/BotFather, send /newbot, follow the prompts.
#      Save the token (looks like 1234567:AAH...).
#    - Open https://t.me/userinfobot to learn your numeric chat id.

# 4. Interactive setup — writes .env.local, creates Convex deployment
npm run setup

# 5. Start everything with one command — server, Convex watcher, debug UI
npm run dev
```

`npm run dev` prints color-prefixed output from each child process and shows a banner once the bot is connected:

```
════════════════════════════════════════════════════════════════════
  Boop is ready — Telegram polling is live.

  🐶 Debug dashboard:        http://localhost:5173
  🤖 Telegram bot:           @your_bot_username
  📞 Allow-listed chat ids:  123456789
════════════════════════════════════════════════════════════════════
```

Open Telegram, message your bot — it replies. Send a voice note and (with `WHISPER_URL` set) it gets transcribed first.

> **Lock down the bot.** Until you set `TELEGRAM_ALLOWED_CHAT_IDS` in `.env.local`, anyone who finds your bot's username can chat with it and burn your Claude tokens. `npm run setup` adds your own chat id automatically — verify it landed in `.env.local`.

> **Voice transcription is opt-in.** With `WHISPER_URL` blank, Boop just replies "Voice transcription isn't enabled — please send text." instead of trying to transcribe. To enable, see [Voice transcription](#voice-transcription-whisper-sidecar) below.

> **Need a public URL?** Polling Telegram needs none. You only need a tunnel for **Composio webhook** (proactive Gmail notifications) or **`TELEGRAM_MODE=webhook`**. Free ngrok / Cloudflare Tunnel both work — see [Public URL setups](#public-url-setups) below.

---

## How the Telegram integration works

`server/telegram.ts` encapsulates everything: a singleton `Bot` instance from `grammy`, the inbound update handler with chat-id allow-list + voice transcription, and both polling and webhook lifecycles. The rest of the codebase only sees four exports:

| Export | Purpose |
|---|---|
| `sendTelegramMessage(chatId, text)` | Outbound. Chunks at 4000 chars (Telegram caps at 4096). Used by the dispatcher, automations, and proactive-email surfacing. |
| `startTypingLoop(chatId)` | Sends `typing` action every 4s until you call the returned `stop()`. |
| `startTelegramPolling()` | Long-polling lifecycle — outbound only, no inbound ports. Default. |
| `createTelegramWebhookRouter()` + `registerTelegramWebhook(publicUrl)` | Webhook lifecycle — Express router for `/telegram/webhook` plus a one-shot registration call. Pick this when you have stable HTTPS and want to skip polling overhead. |

### Conversation ids

Conversations are keyed in Convex by an opaque string. Telegram conversations use `tg:<chat_id>` (e.g. `tg:123456789`). The chat-id-only model is intentionally simpler than the previous `sms:+1...` one — Telegram chat ids are stable per chat (private DM, group, supergroup), and supergroups carry a different sign than DMs so collisions don't happen.

### Polling lifecycle

```
 1. Server boots, reads TELEGRAM_BOT_TOKEN.
 2. grammy connects to api.telegram.org and starts long-poll loop.
 3. Each update flows through the in-memory dedup set (last 1000 update_ids),
    chat-id allow-list check, then handleUpdate().
 4. Voice messages are downloaded via getFile() → sent to WHISPER_URL → text
    is fed to handleUserMessage() like any other text.
 5. SIGINT cleanly stops the bot before exiting.
```

### Webhook lifecycle (optional)

When `TELEGRAM_MODE=webhook` and `PUBLIC_URL` is set, Boop:

1. Mounts `POST /telegram/webhook` on the Express server.
2. Calls `bot.api.setWebhook(<PUBLIC_URL>/telegram/webhook)` once on startup.
3. Lets Telegram push updates instead of polling.

Use this only when you want to skip the long-poll connection or when polling is somehow blocked. Polling is simpler operationally — no DNS, no TLS, no firewall, no clock skew issues.

### What you'll see in the server logs during a conversation

```
server │ [telegram] update 102345 from chat 123456789: "what's on my calendar today?"
server │ [turn a3f21d] ← tg:123456789: "what's on my calendar today?"
server │ [turn a3f21d] tool: recall({"query":"calendar today"})
server │ [turn a3f21d] tool: spawn_agent({"integrations":["google-calendar"],"task":"Pull today's events"})
server │ [agent 9e82c1] spawn: google-calendar [google-calendar] — "Pull today's events"
server │ [agent 9e82c1] tool: list_events
server │ [agent 9e82c1] done (completed, 2.1s, in/out tokens 1234/567)
server │ [turn a3f21d] → reply (3.4s, 140 chars): "Light day — just your 2pm with Sarah..."
server │ [telegram] → sent 140 chars to chat 123456789
```

The same events are written to Convex (`messages`, `executionAgents`, `agentLogs`, `memoryEvents` tables) and streamed to the debug dashboard in real time.

---

## Voice transcription (Whisper sidecar)

Boop ships a small Python sidecar in [`whisper-service/`](./whisper-service/) — FastAPI + [faster-whisper](https://github.com/SYSTRAN/faster-whisper) — that exposes one endpoint:

```
POST /transcribe
{ "url": "https://api.telegram.org/file/bot.../voice.oga" }

→ { "text": "...", "language": "en", "duration": 4.7 }
```

The Node server calls it whenever a Telegram voice / audio message arrives. If `WHISPER_URL` is empty or the call fails, Boop replies with a polite fallback message instead of crashing.

### Local dev

```bash
cd whisper-service
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 9000
```

Then in `.env.local`:
```
WHISPER_URL=http://127.0.0.1:9000/transcribe
WHISPER_MODEL=small        # small (~1GB), medium (~2.5GB), large-v3 (~5GB)
WHISPER_COMPUTE=int8        # int8 (CPU), float16 (GPU)
WHISPER_LANGUAGE=           # blank = auto-detect
```

### On the VPS (Docker Compose)

The bundled `docker-compose.yml` runs Whisper as an isolated container on `boop-net` with no external port, talking to the Node container at `http://whisper:9000/transcribe`. See [Deploy to your VPS](#deploy-to-your-vps).

### Memory footprint cheatsheet

| Model | Approx RAM | Approx speed (CPU) | Quality |
|---|---|---|---|
| `tiny`   | 200 MB | ~10× realtime | rough — fine for short commands |
| `base`   | 400 MB | ~7×  | OK |
| `small`  | 1 GB   | ~5×  | sweet spot for most users |
| `medium` | 2.5 GB | ~2×  | recommended on a 7+ GB VPS |
| `large-v3` | 5 GB | ~0.5× | best quality, needs swap or a beefy box |

---

## Public URL setups

You only need a public URL for:
1. **Composio webhook** (proactive Gmail notifications), or
2. `TELEGRAM_MODE=webhook` (rare — polling is simpler).

Polling Telegram + no Composio webhook = no public URL needed at all.

When you do need one, options ranked by setup cost:

| Setup | Public URL stable across restarts? | Notes |
|---|---|---|
| **Free ngrok** | No — rotates each boot | `npm run dev` starts ngrok automatically if installed. The new URL is in the boot banner. |
| **ngrok reserved domain** (paid) | Yes | Set `NGROK_DOMAIN=boop.ngrok.app` in `.env.local`. |
| **Cloudflare Tunnel** | Yes, free | Set `PUBLIC_URL=https://boop.your-domain.com` and run `cloudflared` yourself. |
| **Traefik on a VPS** | Yes | Use the bundled `docker-compose.yml` — Traefik handles Let's Encrypt automatically. |

> **Composio auto-register.** When you have `COMPOSIO_API_KEY` set and a public URL, `npm run dev` re-registers the Composio webhook subscription with the current URL on each boot. Set `COMPOSIO_AUTO_WEBHOOK=false` to opt out.

---

## Deploy to your VPS

The repo includes a Docker Compose recipe targeting a VPS that already runs Traefik with the `traefik-public` external network and Let's Encrypt automation (the typical pattern from the OVH / Hetzner / Contabo Ubuntu 24.04 setups).

```
boop-agent/
├── Dockerfile               # Node 20 boop image
├── docker-compose.yml       # boop + whisper, two networks, Traefik labels
└── whisper-service/
    └── Dockerfile           # Python 3.11 + faster-whisper
```

**Two networks:**
- `boop-net` (internal) — boop ↔ whisper. Whisper is unreachable from outside the host.
- `traefik-public` (external, opt-in) — only attached to `boop` when you need Composio webhook or Telegram webhook mode.

**Unique Traefik names** (so you don't collide with your other projects on the same Traefik):
- routers: `boop-router-composio`, `boop-router-telegram`
- service: `boop-svc`
- middleware: `boop-auth` (basicauth, only if you expose the debug UI)
- containers: `boop-agent`, `boop-whisper`
- compose project: `name: boop`

### Quickstart on the VPS

```bash
# 1. Clone
git clone https://github.com/<you>/boop-agent.git
cd boop-agent

# 2. Fill in .env.local (copy from .env.example, then edit)
cp .env.example .env.local
# At minimum: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_CHAT_IDS,
#             BOOP_USER_TG_CHAT_ID, CONVEX_URL, COMPOSIO_API_KEY (optional)
# Set WHISPER_URL=http://whisper:9000/transcribe to use the sidecar.

# 3. Build + run
docker compose up -d --build

# 4. Watch logs
docker compose logs -f boop
```

Polling mode requires no inbound DNS or firewall rules — boop reaches Telegram outbound on TCP/443.

### Memory + swap on a 7-8 GB VPS

faster-whisper with `medium` peaks around 2.5–3 GB. Add 4 GB of swap for headroom:

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### Updating

```bash
git pull
docker compose up -d --build
```

The Whisper image is pulled rarely; Compose only rebuilds it if `whisper-service/` changed.

### Convex schema migration note

This release **removes** the `sendblueDedup` table from `convex/schema.ts`. If you're upgrading from an older version that had data in that table, delete the table from the Convex dashboard (or write a one-shot mutation that walks `db.query("sendblueDedup")` and deletes each row) **before** `npx convex deploy` — Convex will refuse to push a schema that drops a non-empty table.

---

## Architecture in 30 seconds

```
┌─────────────┐    update      ┌─────────────────────┐
│   Telegram  │ ─────────────► │ grammy (poll/hook)  │
└─────────────┘                └──────────┬──────────┘
                                          │
                       ┌──────────────────┼──────────────┐
                       │                  ▼              │
                       │       ┌────────────────────┐    │
                       │       │ Whisper sidecar    │    │
                       │       │ (voice → text)     │    │
                       │       └─────────┬──────────┘    │
                       │                 │ (text)        │
                       └─────────────────┼───────────────┘
                                         ▼
                          ┌────────────────────────────┐
                          │    Interaction agent       │
                          │    (dispatcher only)       │
                          │  • recall / write_memory   │
                          │  • spawn_agent(...)        │
                          └────────┬────────┬──────────┘
                                   │        │
                   ┌───────────────┘        └──────────────┐
                   ▼                                       ▼
           ┌───────────────┐                      ┌────────────────┐
           │   Memory      │                      │  Execution     │
           │ (Convex)      │                      │  agent(s)      │
           │ + cleaning    │                      │  + integrations│
           └───────────────┘                      └────────────────┘
```

- **Interaction agent** (`server/interaction-agent.ts`) is the front door. It reads the user's message + recent history, optionally calls `recall`, writes memories, creates automations, and decides whether to answer directly or spawn a sub-agent.
- **Execution agent** (`server/execution-agent.ts`) is spawned per task. It loads only the integrations named in the spawn call and returns a tight answer.
- **Memory** (`server/memory/`) handles writes, recall, post-turn extraction, and daily cleaning. Stored in Convex.
- **Automations** (`server/automations.ts`) poll every 30s for due jobs, spawn an execution agent to run them, and push results back to the user.
- **Integrations** are provided by [Composio](https://composio.dev/?utm_source=chris&utm_medium=youtube&utm_campaign=collab). The dispatcher names toolkits by slug (`spawn_agent(integrations: ["gmail"])`); `server/composio.ts` opens a toolkit-scoped Composio session per spawn and wraps its tools as an MCP server. No per-integration code to write.

Deep dive: [ARCHITECTURE.md](./ARCHITECTURE.md). Adding your own tools: [INTEGRATIONS.md](./INTEGRATIONS.md).

---

## Skills

Skills are reusable playbooks — `SKILL.md` files under `.claude/skills/` that teach the execution agent how to do a specific kind of task (write a YouTube script, draft a cold email, plan a trip, etc.).

**How the Agent SDK handles them:** every `.claude/skills/*/SKILL.md` is loaded when the execution agent boots, and each skill's `description` gets injected into the agent's system prompt along with an instruction to pick the relevant one for the current task. You do **not** select skills per spawn — the agent picks based on which description matches. Only descriptions load upfront; the full SKILL.md body is pulled into context only when the agent actually invokes the skill, so adding more skills is cheap.

The SDK is pretty smart about picking the right skill as long as your `description` is specific and front-loads the trigger phrases ("Use when the user asks to write a video script, turn research into a YouTube video…"). Vague descriptions = missed invocations.

Wiring (in `server/execution-agent.ts`):
- `settingSources: ["project"]` — tells the SDK to load `.claude/skills/`
- `"Skill"` in `allowedTools` — enables the Skill tool

Only the **execution agent** loads skills. The dispatcher (interaction-agent) stays in SDK isolation mode, so it never sees them — which is correct, because the dispatcher should never do work, only route.

**To add a skill:** create `.claude/skills/<kebab-name>/SKILL.md`:

```yaml
---
name: youtube-script-writer
description: Write a tight, retention-focused YouTube script from a topic or outline. Use when the user asks for a video script, wants to turn research into a video, or needs a hook rewritten.
---

<instructions the agent follows when this skill is invoked>
```

Example included: `.claude/skills/youtube-script-writer/`.

---

## Using your Claude Code subscription

The Claude Agent SDK reuses the credentials Claude Code writes to your machine when you sign in. You do not need an `ANTHROPIC_API_KEY`.

- Install once: `npm install -g @anthropic-ai/claude-code`
- Run `claude` in a terminal, sign in.
- That's it — the SDK finds the session automatically.

If you'd prefer an API key (e.g. for a deployed server), set `ANTHROPIC_API_KEY` in `.env.local` and the SDK will use it instead.

---

## Environment variables

Everything lives in `.env.local` (auto-created by `npm run setup`). See `.env.example` for the full list.

| Var | Required | Notes |
|---|---|---|
| `CONVEX_URL` / `VITE_CONVEX_URL` | yes | Convex deployment URL. Written by `npx convex dev`. |
| `TELEGRAM_BOT_TOKEN` | yes | From `@BotFather`. |
| `TELEGRAM_ALLOWED_CHAT_IDS` | yes (in production) | Comma-separated allow-list of numeric chat ids. Without it the bot answers anyone — fine for local testing, dangerous on a public bot. |
| `TELEGRAM_MODE` | no | `polling` (default) or `webhook`. |
| `BOOP_USER_TG_CHAT_ID` | for proactive notices | Chat id that receives proactive Gmail surfacing. Single-user assumption. |
| `WHISPER_URL` | optional | Voice transcription endpoint. Blank = voice notes get a polite fallback. |
| `BOOP_MODEL` | no | Default `claude-sonnet-4-6`. Used as the fallback when no runtime override is set. The user can switch the model at runtime from Telegram ("use opus", "switch to sonnet") via the `set_model` self-tool — that override is stored in the Convex `settings` table and takes precedence over this env var. |
| `BOOP_UPSTREAM_CHECK` | no | Set to `false` to disable the new-version banner on `npm run dev`. Default: on. |
| `PORT` | no | Default `3456`. |
| `PUBLIC_URL` | only for Composio webhook or Telegram webhook mode | Base URL the outside world reaches the Node server on. |
| `VOYAGE_API_KEY` **or** `OPENAI_API_KEY` | optional | Unlocks vector recall. Falls back to substring. |
| `COMPOSIO_API_KEY` | optional | Enables integrations. Without it, plain chat + memory + automations still work. Get one at [app.composio.dev/developers](https://app.composio.dev/developers?utm_source=chris&utm_medium=youtube&utm_campaign=collab). |
| `COMPOSIO_USER_ID` | optional | Stable user id Composio keys connections under. Defaults to `boop-default`. |
| `ANTHROPIC_API_KEY` | optional | Bypass the Claude Code subscription. |

---

## Integrations, via Composio

Boop outsources 3rd-party service integrations to [Composio](https://composio.dev/?utm_source=chris&utm_medium=youtube&utm_campaign=collab). One API key unlocks ~1000 toolkits (Gmail, Slack, GitHub, Linear, Notion, Drive, Stripe, Supabase, HubSpot, Salesforce, Granola, and so on). Composio hosts the OAuth apps, manages token refresh, and exposes every toolkit as a set of Claude-ready tools. Boop never sees an access token.

### Quickstart

1. Grab an API key at [app.composio.dev/developers](https://app.composio.dev/developers?utm_source=chris&utm_medium=youtube&utm_campaign=collab).
2. Add it to `.env.local`:
   ```
   COMPOSIO_API_KEY=sk-comp-...
   ```
3. `npm run dev`.
4. Open the debug dashboard → **Connections** tab. You'll see a curated list of ~20 cards. For each one: click **Connect**, authenticate on Composio's hosted page, done — Composio ships managed OAuth for every curated toolkit. (If you add a custom toolkit that needs your own OAuth app, the card flips to a "Set up →" state pointing at `platform.composio.dev/auth-configs` — rare, but supported.)

After a successful connect, the agent can use that toolkit immediately — no restart.

### How it wires in

Boop keeps the dispatcher / executor split intact. Composio sits under the executor:

```
interaction-agent:  spawn_agent(task, integrations: ["gmail", "slack"])
                              │
                              ▼
execution-agent:    for each slug, open a Composio session scoped to that toolkit:
                      composio.create(BOOP_USER, { toolkits: ["gmail"] })
                      session.tools()          ← returns only Gmail tools
                              │
                              ▼
                    createSdkMcpServer({ name: "gmail", tools })
                              │
                              ▼
                    Sub-agent sees mcp__gmail__GMAIL_*  — nothing else.
```

Key properties:

- **Per-spawn tool scope.** The dispatcher picks which toolkits the sub-agent sees. Tens of tools per spawn, not thousands, so context stays tight and the agent stays fast.
- **Toolkit slug = integration name.** `spawn_agent(integrations: ["linear"])` works for any toolkit you've connected. Unknown slugs just log a warning and are skipped.
- **No tokens on our side.** Every tool call runs through Composio's proxy. If Composio goes down, integrations go down — but your server never holds user OAuth tokens.
- **Multi-account per toolkit.** Connect a second Gmail (work + personal) — each gets its own connection row you can alias. The dispatcher picks up all active connections for the slug.
- **Identity resolution.** Connection cards show the real account email (e.g. `chris@aloa.co`) resolved by calling the toolkit's own "who am I" tool through Composio (`GMAIL_GET_PROFILE`, etc.). Alias per connection if you want a friendlier label.

### Adding toolkits beyond the curated list

The ~20 toolkit catalog is hand-picked in `server/composio.ts:CURATED_TOOLKITS`. To surface another:

```ts
// server/composio.ts
export const CURATED_TOOLKITS: CuratedToolkit[] = [
  // …existing entries…
  { slug: "airtable", displayName: "Airtable", authMode: "managed" },
];
```

`authMode: "managed"` is correct for virtually every toolkit Composio ships today. Use `"byo"` only if Composio doesn't have a hosted OAuth app for that toolkit. If you guess wrong, the UI's auth-config fallback banner catches it and points you at the right dashboard page.

### Cost tracking

Every execution agent's `total_cost_usd` comes straight from the Claude Agent SDK's `result` message (authoritative, matches Anthropic's billing). You'll see real dollar amounts in the Dashboard tab's Cost tile and per-agent cards.

Every LLM call — dispatcher turn, execution-agent run, memory extraction, consolidation (proposer / adversary / judge) — also writes a row to the `usageRecords` table with per-layer tokens (including cache read/write) and cost. `usageRecords:summary` gives you totals by source so you can see which layer is actually burning the bill. Each row reports the model the caller requested, not the model-routing the SDK did internally.

### A note on runaway cost

Boop's `query()` calls don't currently set `maxTurns` or `maxBudgetUsd`. Those are hard stops the SDK exposes — set them and the agent aborts once the threshold hits, with whatever partial result it has.

Kept as-is intentionally for a single-user personal agent: every task is scoped tight (spawned by the dispatcher with a specific task string + a small integration list), integrations are Composio-scoped per spawn so the tool surface stays small, and the existing 15-minute heartbeat (`server/heartbeat.ts`) marks any long-running agent as `failed` and aborts it. In practice execution agents complete in under 60 seconds.

If you deploy Boop in a higher-throughput setting, or hand it integrations that allow looping (webhooks, scrapers), you probably want to set `maxTurns: 20` and `maxBudgetUsd: 2.00` on the `query()` call in `server/execution-agent.ts` as a belt-and-suspenders cap.

### Keeping it in sync

Deeper dive — auth modes, toolkit scoping internals, multi-account flow, per-connection identity: [INTEGRATIONS.md](./INTEGRATIONS.md).

Upgrade path when upstream ships changes: run `/upgrade-boop` inside `claude` (the skill under `.claude/skills/upgrade-boop/`) — previews diffs, backs up, merges, surfaces `[BREAKING]` CHANGELOG entries. See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution rules + the CHANGELOG / migration-skill conventions.

---

## Project layout

```
boop-agent/
├── server/
│   ├── index.ts                   # Express + WS + HTTP routes + Telegram lifecycle
│   ├── telegram.ts                # grammy-based bot: send/receive/voice/typing
│   ├── whisper.ts                 # Thin HTTP client to the Whisper sidecar
│   ├── interaction-agent.ts       # Dispatcher
│   ├── execution-agent.ts         # Sub-agent runner
│   ├── automations.ts             # Cron loop
│   ├── automation-tools.ts        # create/list/toggle/delete MCP
│   ├── draft-tools.ts             # save_draft / send_draft / reject_draft MCP
│   ├── heartbeat.ts               # Stale-agent sweep
│   ├── consolidation.ts           # 3-phase adversarial pipeline
│   ├── usage.ts                   # Shared cost aggregation helper
│   ├── embeddings.ts              # Voyage / OpenAI / local fallback
│   ├── composio.ts                # Composio SDK wrapper
│   ├── composio-routes.ts         # /composio/* HTTP routes for the Debug UI
│   ├── broadcast.ts               # WS fanout
│   ├── convex-client.ts           # Convex HTTP client
│   ├── memory/
│   │   ├── types.ts
│   │   ├── tools.ts
│   │   ├── extract.ts
│   │   └── clean.ts
│   └── integrations/
│       ├── registry.ts
│       └── composio-loader.ts
├── whisper-service/               # FastAPI + faster-whisper sidecar
│   ├── app.py
│   ├── requirements.txt
│   ├── Dockerfile
│   └── README.md
├── convex/
│   ├── schema.ts
│   ├── messages.ts
│   ├── memoryRecords.ts
│   ├── agents.ts
│   ├── automations.ts
│   ├── consolidation.ts
│   ├── conversations.ts
│   ├── drafts.ts
│   ├── memoryEvents.ts
│   └── usageRecords.ts            # Append-only per-call cost log
├── debug/                         # Dashboard
├── scripts/
│   ├── setup.ts                   # Interactive setup CLI
│   ├── dev.mjs                    # One-command orchestrator
│   ├── preflight.mjs              # Checks convex/_generated exists
│   └── composio-webhook.ts        # Auto-register Composio webhook with PUBLIC_URL
├── Dockerfile                     # Node 20 image for the boop process
├── docker-compose.yml             # boop + whisper, Traefik labels
├── README.md                      ← you are here
├── ARCHITECTURE.md
└── INTEGRATIONS.md
```

---

## Upgrading

Boop is a fork-and-own template. You customize your copy freely — system prompts, memory thresholds, extra tools — and pull upstream fixes in on your own schedule.

The intended path is **Claude Code-driven**, modeled on NanoClaw:

```bash
claude                 # inside your repo
/upgrade-boop
```

`/upgrade-boop` is a skill in `.claude/skills/upgrade-boop/SKILL.md`. It:

1. Refuses to run with a dirty working tree.
2. Creates a timestamped rollback tag.
3. Fetches `upstream` and shows you a per-file summary of the merge.
4. Surfaces `[BREAKING]` rows from CHANGELOG.md so you can react.
5. Merges with conflict-aware resolution heuristics.
6. Validates (typecheck + dry-run convex deploy) and reports.

To turn off the upstream check banner:

- **Env var:** add `BOOP_UPSTREAM_CHECK=false` to `.env.local`
- **Or comment it out:** the call lives in `scripts/dev.mjs` — the `spawn("node", ["scripts/check-upstream.mjs"], ...)` block. Delete or comment that block and the check never runs.

### CHANGELOG

Every release lists additions under [CHANGELOG.md](./CHANGELOG.md), with `[BREAKING]` prefixes for anything that requires action. `/upgrade-boop` parses that format automatically.

---

## Troubleshooting

**Agent doesn't reply.**
- Check the server is running: `curl http://localhost:3456/health`
- Check the bot logs into Telegram: look for `[telegram] polling started as @your_bot` in the server output.
- Confirm your chat id is in `TELEGRAM_ALLOWED_CHAT_IDS` (or that it's blank for testing).

**Convex errors / `VITE_CONVEX_URL is not set`.**
- Run `npx convex dev` manually. Ensure `.env.local` has both `CONVEX_URL` and `VITE_CONVEX_URL`.

**"Could not find public function for X:Y".**
- `CONVEX_DEPLOYMENT` and `CONVEX_URL` in `.env.local` are pointing at different projects. `convex dev` pushes functions to `CONVEX_DEPLOYMENT` but the client reads from `CONVEX_URL`. Fix: make sure the URL has the same name as the deployment — `CONVEX_DEPLOYMENT=dev:foo-bar-123` → `CONVEX_URL=https://foo-bar-123.convex.cloud`. Re-running `npm run setup` now auto-syncs these.

**Voice notes never get transcribed.**
- `WHISPER_URL` is unset, or the sidecar isn't reachable. From the boop container: `curl $WHISPER_URL`. From outside Docker: check the sidecar is bound to `127.0.0.1:9000` and that boop runs on the same host.
- Whisper takes a while on the first request — the model loads lazily. Subsequent requests are fast.

**Agent replies but can't use my integration.**
- Check `COMPOSIO_API_KEY` is set in `.env.local`.
- Check the toolkit shows as **Connected** in the Connections tab.
- Watch server logs for `[composio] registered …` at boot and `[integrations] unknown integration: …` on spawn attempts.

**I want to skip Telegram for now.**
- The server exposes `POST /chat` with `{ conversationId, content }` — curl or a tiny client can drive the agent directly. The Debug UI's Chat tab uses this same endpoint.

**Claude SDK says no credentials.**
- Run `claude` once and sign in, or set `ANTHROPIC_API_KEY` in `.env.local`.

**`telegram` errors with `409 Conflict: terminated by other getUpdates request`.**
- Two boop processes are polling at once. Stop the older one or switch one to `TELEGRAM_MODE=webhook`.

**"Dashboard crashed" in the debug UI.**
- The ErrorBoundary caught something. Check the server logs (`server │` stream) and the browser console — both will have the real error. Most common cause: a new Convex function hasn't been deployed yet. Restart `npm run dev` so `convex dev` re-pushes.

---

## License

MIT. Build whatever you want on top of this.
