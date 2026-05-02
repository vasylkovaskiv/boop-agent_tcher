# Perplexity Pro Search — full setup guide

Step-by-step, zero-to-running. This is what you do to get the optional
`perplexity` integration working from scratch.

The integration uses a real Perplexity Pro account: cookies from a
logged-in browser session are pulled out of [Dolphin Anty](https://dolphin-anty.com/)
once a week, stored in Convex, and replayed by the bot through a
residential proxy on every search request. Without all three pieces
(Pro account + residential proxy + cookies refreshed regularly) Perplexity
will either downgrade you to the free tier silently, hit you with
Cloudflare 403s, or kill the session entirely.

This guide assumes you already have the bot deployed and working on a VPS.
If not, do that first — see [README.md → Deploy to your VPS](../README.md#deploy-to-your-vps).

---

## Prerequisites

Before you start, you need:

- A Perplexity Pro account (~$20/month). [Sign up here](https://www.perplexity.ai/pro).
  This guide assumes Pro — the integration won't degrade gracefully to free
  tier; it'll just return worse answers than your in-built `WebSearch`.
- A working Dolphin Anty install on **your local machine** (Windows or macOS).
  The free tier is enough — you only need 1 browser profile.
  [Download here](https://dolphin-anty.com/).
- The bot's repo cloned on the same local machine (so you can run the
  cookie-refresh script). On the VPS where the bot runs, you don't need this.
- About 30–45 minutes for the first-time setup.

---

## Step 1 — Buy a residential proxy

We recommend [asocks.com](https://asocks.com/) — pay-as-you-go, ~$3/GB,
no minimum, supports both HTTP/HTTPS and SOCKS5. Any residential proxy
provider works (Bright Data, Smartproxy, IPRoyal, etc.) but the example
URLs below are asocks-specific.

**Why residential is non-negotiable:** Perplexity sits behind Cloudflare,
which scores datacenter ASNs as high-risk. Even one request from a Hetzner
or DigitalOcean IP to `/rest/sse/perplexity_ask` typically returns HTTP 403
with a Cloudflare "Just a moment…" interstitial — and once the cookie has
been seen on a flagged IP, the session can be invalidated server-side
within minutes. Residential proxies route you through real consumer ISPs,
which Cloudflare scores as low-risk.

### 1.1 Register

1. Go to https://asocks.com/, sign up, verify email.
2. Top up your balance — $5 is enough to start. Pay via card or crypto.

### 1.2 Configure a "proxy list"

asocks calls them "proxy lists" — each list is a set of credentials that
maps to a rotating pool of IPs.

1. Dashboard → **Proxy** → **Create proxy**.
2. Settings:
   - **Country**: pick one and **stick to it**. Match the IANA timezone you
     plan to set as `PERPLEXITY_TIMEZONE` later (e.g. country=Germany →
     timezone=`Europe/Berlin`). Mismatched country/timezone is a
     fingerprint anomaly that can trigger re-verification challenges.
   - **City**: leave on Auto unless your country is huge (US, BR, RU).
   - **Rotation**: **Sticky session, ≥10 minutes**. Each Perplexity request
     can take 5–15s for Pro Search; you don't want the IP rotating
     mid-request.
   - **Protocol**: HTTPS (recommended — undici has best HTTPS support)
     or SOCKS5. Both work.
3. Save. asocks gives you something like:
   ```
   Host: residential.asocks.com
   Port: 1080
   Login: user-asocks-zone-residential-region-DE
   Password: somelongpassword123
   ```
4. Compose your `ASOCKS_PROXY_URL`:
   ```
   http://user-asocks-zone-residential-region-DE:somelongpassword123@residential.asocks.com:1080
   ```
   (Or `socks5://...` if you picked SOCKS5.)

### 1.3 Verify the proxy works

From your laptop (not the bot's server yet):

```bash
curl -sS --proxy 'http://user...:pass...@residential.asocks.com:1080' \
  https://api.ipify.org
# → 84.123.45.67  (an IP in the country you picked)

curl -sS --proxy 'http://user...:pass...@residential.asocks.com:1080' \
  https://www.perplexity.ai/api/auth/csrf
# → {"csrfToken": "..."}   ← anything but a Cloudflare 403 page
```

If the second call returns a 403 with HTML content, the proxy is still
flagged. Rotate to a different `region-XX` or contact asocks support.

---

## Step 2 — Configure Dolphin Anty profile to use the same proxy

This is the single most-skipped step and the one that breaks cookie reuse
fastest. Perplexity validates session cookies against the IP that issued
them — if you log into Perplexity through residential IP A, then the bot
calls the API through residential IP B, Perplexity sees the mismatch
within 1–2 requests and invalidates the session.

**Solution:** make Dolphin connect through the same `ASOCKS_PROXY_URL`
the bot uses, so the cookie jar is born on the same proxy pool it'll be
replayed on.

### 2.1 Create a profile

1. Dolphin → **New profile**.
2. **Operating system**: pick to match the country you bought the proxy in
   (Windows for most countries; macOS works too). Don't use Linux — too
   small a fingerprint cohort.
3. **Browser**: Chrome (latest). Default version is fine.
4. **Network → Proxy**: enter the asocks credentials:
   - Type: HTTP (or SOCKS5 if you bought that)
   - Host: `residential.asocks.com`
   - Port: `1080`
   - Login / Password: the asocks creds from step 1.2
5. Click **Check IP** in Dolphin — it should show an IP in your target
   country. If not, the proxy isn't applied.
6. **WebRTC**: set to **Replace with proxy IP** (not "real").
7. **Timezone, Geolocation, Language**: match the proxy country (German
   proxy → `de-DE` language, `Europe/Berlin` timezone, German lat/long).
   Dolphin has an **Auto** option for some of these — that's fine.
8. **Canvas, WebGL, AudioContext**: leave on default (Dolphin's noise mode).
9. Save profile, **note the profile ID** — you'll need it for the refresh
   script. Dolphin shows it in the profile list.

### 2.2 Log into Perplexity

1. In Dolphin, **Start** the profile. It opens a Chrome window.
2. Navigate to https://www.perplexity.ai.
3. Sign in with your Pro account.
4. **Verify Pro is active**: top-right corner should say "Pro" and the
   Search type selector at the bottom of the input should show "Pro Search"
   as an option. If you only see "Search", you're on free tier.
5. **Run one Pro search manually** to make sure it works:
   - Type something like "what's the weather in Berlin today"
   - Make sure mode is Pro
   - Wait for the answer — it should show citations + steps
6. Don't log out. Don't close Chrome — just leave the profile running, or
   stop it cleanly via Dolphin (Dolphin saves state).

---

## Step 3 — Enable Dolphin's Local API

The cookie-refresh script attaches to Dolphin via its built-in CDP (Chrome
DevTools Protocol) bridge, which Dolphin exposes through a local HTTP API
on port 3001 by default.

1. Dolphin → **Settings** (gear icon) → **API** (or "Local API" — wording
   varies by Dolphin version).
2. **Enable Local API**. Default port `3001`. Leave it.
3. **API token**: blank for free tier. Paid Dolphin tiers issue a token
   you'd then put into `DOLPHIN_API_TOKEN`. Free tier is happy without one.
4. Verify from your terminal:
   ```bash
   curl http://localhost:3001/v1.0/browser_profiles
   # → JSON list of your profiles
   ```

---

## Step 4 — Configure the bot's environment

On the **server where the bot runs** (your VPS), edit `.env.local`:

```env
# Required for the integration to register
ASOCKS_PROXY_URL=http://user-asocks-zone-residential-region-DE:somepassword@residential.asocks.com:1080

# IANA timezone — match the proxy country
PERPLEXITY_TIMEZONE=Europe/Berlin

# Optional: dedicated chat for cookie-expired alerts. Defaults to first
# id from TELEGRAM_ALLOWED_CHAT_IDS, which is usually what you want.
# TELEGRAM_ADMIN_CHAT_ID=
```

Restart the bot. In the logs you should see:

```
[perplexity] registered
[perplexity] keep-alive scheduled for ~6h from now
```

If you see `[perplexity] disabled — ASOCKS_PROXY_URL not set` instead,
the env var didn't make it through. Check spelling and the restart.

At this point the integration is **registered but not functional yet** —
Convex has no cookies. The next request from the dispatcher will return
`Perplexity error: no cookies in Convex (run npm run refresh-perplexity-cookies)`.
Time to seed cookies.

---

## Step 5 — First cookie refresh

This step runs on **your local machine**, not the VPS. Dolphin Anty is a
desktop app — there's no way to do this from a Linux server.

### 5.1 Make sure the bot's Convex deployment is reachable

The script needs `CONVEX_URL` to push cookies to the same Convex deployment
the bot reads from. Find that URL in the bot's `.env.local`:

```env
CONVEX_URL=https://something-prod.convex.cloud
```

### 5.2 Clone the bot's repo locally (if you haven't)

```bash
git clone https://github.com/vasylkovaskiv/boop-agent_tcher.git
cd boop-agent_tcher
git checkout deploy
npm install
```

### 5.3 Start the Dolphin profile

Important: the profile **must be running** when you run the refresh script
— that's how the script attaches to its CDP endpoint. Dolphin → click
**Start** on the profile. A Chrome window opens. **Don't close it.**

### 5.4 Run the script

```bash
export CONVEX_URL=https://something-prod.convex.cloud
npm run refresh-perplexity-cookies -- --profile-id=YOUR_DOLPHIN_PROFILE_ID
```

Expected output:

```
[refresh] starting profile abc123 via http://localhost:3001
[refresh] CDP endpoint: ws://localhost:54321/devtools/...
[refresh] extracted 14 cookies (UA len 134)
[refresh] cookies updated in Convex (timezone=UTC)
```

The script will refuse to push cookies if `__Secure-next-auth.session-token`
is not in the jar — that's the cookie that proves you're logged in. If
you see:

```
[refresh] FATAL: Dolphin profile abc123 does not have a "__Secure-next-auth.session-token" cookie set.
```

…it means either (a) you didn't actually log into Perplexity in that
Dolphin profile, or (b) you logged out at some point. Open the profile
manually, log into perplexity.ai again, run the script again.

### 5.5 Smoke-test

Send the bot a message in Telegram that should trigger a Perplexity
search:

> "Поищи новости про NVDA сегодня"

The dispatcher should:
1. Send a quick `send_ack` ("Looking…")
2. Spawn an execution agent with `integrations: ["perplexity"]`
3. Reply with a synthesised answer + a `**Sources:**` section listing
   real URLs

In the server logs you should see:

```
[perplexity] queue size 1
[perplexity] search start mode=pro query="..."
[perplexity] search done in 8420ms
```

If everything works — congrats, you're done with the first-time setup.

---

## Step 6 — Set up a refresh cadence

Cookies live for 5–8 days typically before Perplexity rotates them. The
keep-alive loop in the bot will alert you on Telegram before they expire,
but you can pre-empt the alerts by refreshing on a schedule.

### Option A — manual (simplest)

Once a week, on whatever day suits you:
1. Make sure the Dolphin profile is still running (or start it).
2. Run `npm run refresh-perplexity-cookies -- --profile-id=...` from the
   bot repo on your local machine.

Set a recurring calendar event. Done.

### Option B — automated via cron / launchd

This requires Dolphin Anty to be running on a machine that's always on
(your laptop if it never sleeps, a small home server, or — more
realistically — the same VPS the bot runs on, but with Dolphin running in
a desktop session like xrdp or VNC).

Example cron line (Linux, run every Tuesday at 04:00 local):

```
0 4 * * 2 cd /path/to/boop-agent_tcher && CONVEX_URL=https://... DOLPHIN_PROFILE_ID=... npm run refresh-perplexity-cookies -- --profile-id=$DOLPHIN_PROFILE_ID >> /var/log/perplexity-refresh.log 2>&1
```

Caveats:
- The Dolphin profile **must be in a "started" state** when the cron
  fires — Dolphin's API can only attach to running profiles, not start
  them headlessly (in the free tier). If you can keep the profile started
  24/7, this works.
- If the cron fails, you'll find out through the Telegram alert when
  cookies actually expire 1–2 days later. Build observability accordingly.

### Option C — hybrid

I'd recommend: do option A (manual weekly) until you trust the integration
is stable for ~2–3 weeks. Then if you want to automate, switch to option B
on whatever infrastructure you've got. Don't over-engineer this from day 1.

---

## Step 7 — Hardening (optional, do later)

### 7.1 Dedicated Perplexity account

If you're worried about losing your main Perplexity account to a
suspension, create a second Pro account (different email, different card
if possible) and use that one for the bot. ~$20/month for peace of mind.

### 7.2 Cycletls for TLS fingerprint impersonation

Plain undici fetch through a residential proxy is the happy path. But
Cloudflare's bot-management score sometimes flags JA3 fingerprints that
don't match common browsers. If you start seeing systematic 403s on the
search endpoint:

```bash
npm install cycletls
echo 'PERPLEXITY_USE_CYCLETLS=1' >> .env.local
# Restart the bot
```

The client lazy-imports cycletls only when the flag is on, so production
installs without it keep working.

### 7.3 Lower the per-day request budget

If you start scaling beyond a single user, monitor the Perplexity Pro
quota. The Pro tier officially allows 300 Pro Searches/day, but anecdotally
heavy use can trigger soft rate-limiting at ~200/day. The integration's
sequential queue + jitter prevents bursts, but if you're worried, switch
some tasks to `mode: "concise"` in the routing skill — those are 1/10th
the cost on Perplexity's side.

---

## Troubleshooting

See [DEPLOYMENT_TROUBLESHOOTING.md → section 12](../DEPLOYMENT_TROUBLESHOOTING.md)
for the full failure-mode matrix. Common ones:

| Symptom | Likely cause | Fix |
|---|---|---|
| `[perplexity] disabled` in logs | `ASOCKS_PROXY_URL` not set | Add to `.env.local`, restart |
| `no cookies in Convex` on first request | Cookies not seeded | Run `refresh-perplexity-cookies` |
| `HTTP 401 — cookies expired` | Cookies rotated server-side | Run `refresh-perplexity-cookies` |
| Systematic Cloudflare 403s right after refresh | TLS fingerprint flagged | `PERPLEXITY_USE_CYCLETLS=1` + `npm install cycletls` |
| Cookies expire every ~24h instead of weekly | IP mismatch — Dolphin and bot use different proxies | Configure Dolphin profile to use `ASOCKS_PROXY_URL` |
| Answer present but says "I cannot access real-time data" | Wrong `search_focus` | Bug in `server/perplexity-client.ts` — check `search_focus: "internet"` is in the request body |
| `HTTP 429 — Pro Search rate limit` | Hit daily quota | Wait until next UTC day; switch some queries to `mode: "concise"` |

---

## What this integration costs you, ongoing

- **Perplexity Pro**: $20/month per account.
- **asocks residential proxy**: ~$0.10–0.30/month at moderate use
  (~50–200 searches/day, ~20–80 KB per search after compression). The
  proxy bills on bytes transferred, not requests.
- **Your time**: ~5 minutes/week to run the refresh script. Less if you
  automated it.
- **Risk**: small (≤2%) chance per month of the Perplexity account
  getting flagged for "automation" and either rate-limited or
  suspended. Mitigated by sequential queue, request jitter, residential
  IP, matching timezone/locale, and no parallelism.

---

## What this integration does NOT do

- **No CAPTCHA solving.** If Perplexity throws a Cloudflare CAPTCHA at
  you (rare), the bot can't get past it. You'll need to open the Dolphin
  profile manually, solve the CAPTCHA in the browser, then refresh
  cookies again.
- **No multi-account rotation.** One profile, one cookie jar at a time.
  If you want round-robin across multiple Pro accounts, that's a separate
  feature — the schema would need to change.
- **No "fall back to free tier on cookie expiry".** If cookies are gone,
  the integration returns an error and the worker (per the routing skill)
  falls back to the built-in `WebSearch` tool. We don't try to use
  Perplexity unauthenticated.
