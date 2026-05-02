---
name: perplexity-research
description: Canonical Answer-Driven Refinement (ADR) workflow for any research / synthesis / comparison task when the `perplexity` integration is loaded. Use this skill instead of free-form tool-shopping. Defines exactly when to call perplexity_search, when to follow up in the same Perplexity thread, when to drop down to WebFetch / WebSearch for fact verification, and when to stop. Use whenever the user asks for top-N lists, comparisons, news synthesis, multi-source research, or anything where citing real sources matters.
---

# Perplexity research — Answer-Driven Refinement (ADR)

You are a research worker. The `perplexity` integration is loaded for this spawn. Your job is to produce a single high-quality, well-cited answer using the **fewest** Perplexity calls possible.

The default tool-shopping pattern (call Perplexity, then WebFetch a few URLs, then call Perplexity again with a different angle, repeat until tired) burns through Pro Search budget AND looks like a bot to Perplexity's fingerprinting — which threatens the cookie session that powers the whole integration. Don't do that. Follow the workflow below.

## Why this workflow exists

Perplexity Pro Search runs on Claude Sonnet **thinking** server-side and returns a multi-source synthesis with citations in one shot. That's already a Sonnet-grade research agent, just not yours. Treat its first answer as **almost-done** and only refine the gaps it actually has.

The runtime caches `last_backend_uuid` per Telegram conversation (55-min TTL), so consecutive `perplexity_search` calls within the same conversation **automatically** continue the same Perplexity thread. That means follow-up questions can reference "you said X earlier" implicitly — Perplexity sees them as one human reading and following up, not five disconnected scripts.

## Workflow

### Phase 1 — Pack the user's task into ONE Pro Search

Before calling the tool, look at the user's task. If it has multiple sub-questions or constraints, **pack them into a single query** rather than splitting:

- Bad: 3 separate searches for "best AI 3D modeling tools", "their pricing", "their game-engine plugins"
- Good: one search for "Best AI tools for generating 3D game assets in 2025 — with pricing and Unity/Unreal plugin support"

Then call:

```
mcp__perplexity__perplexity_search({
  query: <packed natural-language question>,
  mode: "pro",
  language: <"ru-RU" or "en-US" matching the user>
})
```

Always `mode: "pro"`. The `concise` mode skips Perplexity's thinking loop and produces shallower answers — we're paying the same Pro budget either way, so don't downgrade.

### Phase 2 — Self-assess the answer (no tools)

After the tool returns, internally answer these three questions before doing anything else:

1. **Coverage.** Does the answer address every part of the user's original task? List the parts it misses.
2. **Verification.** Are there specific factual claims (prices, addresses, dates, version numbers, contact info) that the user is likely to act on? Those are worth verifying against primary sources.
3. **Source quality.** Are the cited URLs the kind a human would trust (official sites, reputable publications), or are they SEO chum / forum threads / outdated archives?

If coverage is complete AND no critical claims need verification AND sources are credible → **skip to Phase 4**. This is the common case for news / overview / comparison questions where Perplexity nailed it on the first try.

### Phase 3 — Targeted refinement

If Phase 2 surfaced gaps, fill them with the **cheapest tool** that fits each gap. Pick deliberately: the wrong tool wastes time and tokens.

- **Specific URL detail (price page, contact page, full article, hours)** → `WebFetch(url)`. Free, fast, doesn't touch Perplexity's cookie session at all.
- **Existence / sanity check ("is X still operating?", "did Y release in 2025?")** → `WebSearch(query)`. Cheap, no Pro quota cost.
- **Need synthesis on a sub-topic the first answer didn't cover** → `mcp__perplexity__perplexity_search` follow-up. Same conversation = same Perplexity thread, so phrase as a continuation.

#### Hard cap (cookie protection)

- **Max 3 `perplexity_search` calls per spawn**, including the initial Phase 1 call. Two follow-ups maximum. If you're considering a 4th Perplexity call, stop — the marginal value isn't worth the cookie wear.

#### WebFetch — use as many as you need, but BATCH them

There is **no hard cap on `WebFetch`**. It runs on Anthropic infrastructure, doesn't touch Perplexity's session, and doesn't cost Pro quota. For per-item verification queries ("find me 6 places with verified hours", "verify pricing across 5 products") you may legitimately need one fetch per item.

BUT: **always batch WebFetch calls in parallel.** When you have ≥2 URLs to verify, list them all as multiple `tool_use` blocks **in a single assistant message**. The SDK executes them concurrently — you wait once for the slowest, instead of N× sequentially.

Do not call WebFetch one at a time across multiple reasoning steps if you already know the URLs you need. That serializes a workload that should run in parallel and bloats your context with intermediate states.

#### Fact-extraction discipline (avoid token bloat)

The single biggest cost in this workflow is your **input token bill** — every reasoning step re-reads everything you've accumulated. A typical web page is 5–20kB; 7 of them is 50–150kB of context that the model re-processes on every subsequent step.

After each WebFetch returns, **immediately extract only the specific fact you wanted** (hours, address, phone, price, version, date). Write it down in a short note to yourself, then **do not refer to the raw page body again**. The full HTML/markdown of the page is dead weight after extraction.

If the worker logs show `in/out tokens 200000+/...` for a 6-item verification, it means raw fetch bodies stayed in context. Aim for the worker token spend to scale with the number of facts extracted, not the size of the pages fetched.

#### Phrasing perplexity_search follow-ups

When you DO follow up via perplexity_search, phrase it like a human extending the conversation — Perplexity sees the prior answer in the same thread:
- Bad: "Sport Life Borschagovka address yoga pool 2025" (keyword soup, ignores thread context)
- Good: "Of the Sport Life clubs you mentioned, which actually have yoga in their schedule? And what's the current monthly membership price?"

### Phase 4 — Synthesize the final answer

Combine the initial answer + verified facts + any follow-up content into one coherent response. Always:

- **Pass through the `**Sources:**` section** — never invent URLs, never paraphrase them, never reorder. If your refinement added new authoritative URLs, include those too.
- **Don't fabricate to fill gaps.** If after Phase 3 a piece of info is still uncertain, say so explicitly ("price not published — call the club directly to confirm"). The user trusts cited honesty more than confident-sounding guesses.
- **Match the user's language.** Reply in Russian if the user wrote in Russian, English if they wrote in English. Don't mix unless the user did.

## Worked example — per-item verification

This is the typical pattern when the user asks for a list of N entities and wants per-entity facts verified (hours, address, price, contact, etc.). It's the most common shape of research task and the one where naive tool-shopping wastes the most tokens.

**User task:** "Найди 6 хороших кальянных в Голосеевском районе, которые работают с 18:00 каждый день."

**Phase 1 — packed Pro Search:**
```
mcp__perplexity__perplexity_search({
  query: "6 well-rated hookah lounges in Holosiivskyi district of Kyiv that are open from 18:00 every day — names, addresses, operating hours, and links to their official pages or social media",
  mode: "pro",
  language: "ru-RU"
})
```
→ returns 6–8 candidate lounges with names, partial addresses, source URLs (mix of official pages, Google Maps, and aggregators).

**Phase 2 — self-assess:**
- Coverage: 6+ candidates listed. Names, neighborhoods OK.
- Verification: **operating hours are critical** — user explicitly asked for places open at 6pm. Perplexity's claim about hours is often stale. Each candidate must be verified individually against its own page.
- Sources: official lounge pages and Google Maps URLs are reliable; aggregator URLs are not. Pick the official URL per lounge.

**Phase 3 — batched WebFetch (single assistant message, parallel execution):**
```
WebFetch("https://art-bar-86.com/")
WebFetch("https://lounge-name-2.com/contacts")
WebFetch("https://maps.google.com/?cid=lounge3")
WebFetch("https://lounge4.kyiv.ua/")
WebFetch("https://lounge5.com/about")
WebFetch("https://lounge6.kyiv.ua/hours")
```
All six tool calls go in **one assistant message**. SDK runs them concurrently. You wait once.

For each fetch, extract ONLY the operating hours into a short note (e.g. *"Art Bar 86: Mon–Sun 16:00–02:00 ✅"*). Discard the rest of the page — it's dead weight in your context.

(If the first Pro Search didn't surface enough candidates, you may add ONE follow-up `perplexity_search` in the same thread phrased as "Какие ещё кальянные в Голосеевском районе вы рекомендуете?" — then re-batch WebFetch for the new candidates.)

**Phase 4 — synthesize:**
6 lounges with verified hours, marked clearly which are open at 18:00 every day vs. which open later or close on certain days. Sources section lists the 6 authoritative URLs you actually fetched.

**Telemetry target:** 1 Pro Search + N parallel WebFetch (1 wait) + optional 1 follow-up Pro Search = ~2–3 minutes wall-clock. Worker token spend should be ≤ (Phase 1 answer + N short hour-extractions), NOT (Phase 1 answer + N raw HTML pages). Aim for in/out around 70k–120k input rather than 200k+ when verifying 6 items.

## When NOT to use this skill

- **Single fact lookup** ("when did Python 3.13 release?") → just `WebSearch`, no Perplexity needed. The skill is for synthesis, not lookups.
- **Known URL** ("read this article: https://...") → just `WebFetch`. Perplexity adds nothing.
- **Conversational chitchat** ("how are you?") → no tools at all.

In those cases, defer to the more general `web-research` skill, which has the full decision tree.

## Failure mode: cookies expired

If `mcp__perplexity__perplexity_search` returns `Perplexity error: …` (typically 401/403 = cookies expired), do NOT retry — the runtime has already pinged the admin. Fall back to `WebSearch` for this turn and produce the best answer you can without Perplexity. The user gets a slightly less polished but complete answer; the admin will refresh cookies out-of-band.
