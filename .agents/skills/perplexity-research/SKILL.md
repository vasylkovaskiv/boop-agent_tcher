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

### Phase 3 — Targeted refinement (max 3 extra tool calls total)

If Phase 2 surfaced gaps, fill them with the **cheapest tool** that fits each gap:

| Gap type | Tool | Why |
|---|---|---|
| Specific URL detail (price page, contact page, full article) | `WebFetch(url)` | Free, fast, doesn't touch Perplexity's session at all. Parallelize when you have multiple URLs. |
| Existence / sanity check ("is X still operating?", "did Y release in 2025?") | `WebSearch(query)` | Cheap, no Pro quota cost. |
| Need synthesis on a sub-topic the first answer didn't cover | `mcp__perplexity__perplexity_search` follow-up | Same conversation = same Perplexity thread, so phrase as a follow-up ("what about X for the clubs you just listed?"). |

**Hard limits:**
- **Max 3 perplexity_search calls per spawn**, including the initial Phase 1 call. Two follow-ups maximum.
- **Max 3 follow-up tool calls in Phase 3 total** (across WebFetch / WebSearch / perplexity_search combined).
- If you're considering a 4th Perplexity call, stop. The marginal value isn't worth the cookie wear.

When you DO follow up via perplexity_search, phrase it like a human extending the conversation:
- Bad: "Sport Life Borschagovka address yoga pool 2025" (keyword soup, ignores thread context)
- Good: "Of the Sport Life clubs you mentioned, which actually have yoga in their schedule? And what's the current monthly membership price?"

### Phase 4 — Synthesize the final answer

Combine the initial answer + verified facts + any follow-up content into one coherent response. Always:

- **Pass through the `**Sources:**` section** — never invent URLs, never paraphrase them, never reorder. If your refinement added new authoritative URLs, include those too.
- **Don't fabricate to fill gaps.** If after Phase 3 a piece of info is still uncertain, say so explicitly ("price not published — call the club directly to confirm"). The user trusts cited honesty more than confident-sounding guesses.
- **Match the user's language.** Reply in Russian if the user wrote in Russian, English if they wrote in English. Don't mix unless the user did.

## Worked example

**User task:** "Найди топ-5 фитнес-клубов в Киеве с йогой и бассейном — нужны адреса, цены, контакты."

**Phase 1 — packed Pro Search:**
```
mcp__perplexity__perplexity_search({
  query: "Top fitness clubs in Kyiv right bank with yoga classes and a swimming pool — addresses, monthly membership prices, contact info, valid for 2025",
  mode: "pro",
  language: "ru-RU"
})
```
→ returns 7 candidate clubs with overview + 8 source URLs.

**Phase 2 — self-assess:**
- Coverage: addresses are there for some, missing for 2. Yoga/pool flags are there. **Prices are vague** ("starting from 3500 UAH/month") and unverified.
- Verification: prices and current operating status are the actionable facts. Worth a quick check.
- Sources: sportlife.ua, 5element.ua, skyfitness.ua → all credible. Other 5 are SEO aggregators — don't follow them.

**Phase 3 — 2 targeted refinements (parallel):**
- `WebFetch("https://sportlife.ua/ru/clubs/kiev/")` — pull the canonical Sport Life list with current addresses.
- `WebFetch("https://5element.ua/contacts/")` — verify 5 Element address + yoga/pool availability.

(Skip the 3rd refinement — Skyfitness was an aggregator, not authoritative.)

**Phase 4 — synthesize:**
Top-5 ranked list, addresses verified for 4 of 5 clubs, prices marked "from ~3500 UAH/month, confirm with club" where unverified. Sources section includes the 3 authoritative URLs (sportlife.ua, 5element.ua, swimming-cool.com.ua) but NOT the SEO chum.

**Telemetry:** 1 Pro Search + 2 WebFetch (parallel) + 0 follow-up Perplexity = total 1 Perplexity call against the cookie session, ~1.5 minutes wall-clock, far less Pro quota burned than calling Perplexity 5 times.

## When NOT to use this skill

- **Single fact lookup** ("when did Python 3.13 release?") → just `WebSearch`, no Perplexity needed. The skill is for synthesis, not lookups.
- **Known URL** ("read this article: https://...") → just `WebFetch`. Perplexity adds nothing.
- **Conversational chitchat** ("how are you?") → no tools at all.

In those cases, defer to the more general `web-research` skill, which has the full decision tree.

## Failure mode: cookies expired

If `mcp__perplexity__perplexity_search` returns `Perplexity error: …` (typically 401/403 = cookies expired), do NOT retry — the runtime has already pinged the admin. Fall back to `WebSearch` for this turn and produce the best answer you can without Perplexity. The user gets a slightly less polished but complete answer; the admin will refresh cookies out-of-band.
