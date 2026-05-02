---
name: web-research
description: Choose the right web tool for a research task — WebSearch for simple lookups, WebFetch for known URLs, mcp__perplexity__perplexity_search (concise/pro) for synthesised multi-source answers. Use this skill whenever the user asks about news, current events, comparisons, technical research, or anything that requires up-to-date information from the web.
---

# Web research routing

You have four web tools at your disposal. Each one has a sweet spot — pick the cheapest tool that actually answers the question. Don't reach for Perplexity when WebSearch would do, and don't reach for WebSearch when you already know the answer.

> **If `perplexity` is loaded and the task is research / synthesis / comparison / top-N — stop reading this skill and invoke `perplexity-research` instead.** That skill encodes the canonical workflow for the Perplexity integration (Answer-Driven Refinement: one packed Pro Search → self-assess → 0–3 targeted refinements). The decision tree below is the fallback for non-Perplexity routing or when Perplexity isn't loaded for this spawn.

## Decision tree

1. **Do I already know the answer with high confidence?**
   Don't search. Answer from your own knowledge. Examples:
   - "What's 2 + 2?" → 4.
   - "Translate this Russian sentence." → translate.
   - "What's the capital of France?" → Paris.

2. **Do I have a specific URL the user (or a previous tool) gave me?**
   Use `WebFetch(url)`. Fastest, cheapest, single page.

3. **Is this a simple fact lookup with a short, stable answer?**
   Use `WebSearch(query)`. Examples:
   - "When did Python 3.13 release?"
   - "What version of Node does Convex require?"
   - "Who is the current CEO of OpenAI?"

4. **Does the question need synthesis across multiple sources, current events, or nuanced comparisons?**
   Use `mcp__perplexity__perplexity_search`. Examples that justify Perplexity:
   - "What happened with NVIDIA today?" / "Что нового про NVDA"
   - "Compare Claude 3.5 vs GPT-4o for coding."
   - "What do experts think about the new EU AI Act?"
   - "Summarise the latest Anthropic paper on interpretability."
   - Anything with words like "latest", "current", "what's happening", "compare", "сегодня", "сравни", "новости".

## Choosing Perplexity mode

Within `mcp__perplexity__perplexity_search`, you have two modes:

- **`mode: "pro"` (default)** — Pro Search with Claude Sonnet thinking. 5–15 seconds. Multi-step reasoning across sources. Use for anything non-trivial, especially current events and comparisons.
- **`mode: "concise"`** — Single-shot search. 3–5 seconds. Cheaper to run, caches longer. Use for simpler "tell me about X" lookups where deep synthesis isn't needed but a couple of cited sources are still helpful.

If in doubt, default to `pro`. The latency premium is worth it for the citation quality.

## Constructing the query

- Pass the user's question **as natural language**. Don't preface with "Search for…" or "Please find…" — those leak into Perplexity's search terms and contaminate results.
- Don't include system prompt text, the dispatcher's task description, or persona descriptions. Just the question.
- For Russian users with Russian-language questions, pass `language: "ru-RU"` so Perplexity prefers Russian-language sources. For everything else default English.

## Handling the response

The tool returns markdown with inline mentions plus a `**Sources:**` section listing real URLs. Always:

1. **Pass the Sources section through verbatim** to the dispatcher — never paraphrase URLs, never invent new ones, never reorder. The user (and the dispatcher) want to click through to the originals.
2. **Don't claim things the answer didn't claim.** If Perplexity didn't find an answer, say so — don't fabricate from your prior knowledge to "fill in".
3. **If the tool returns `Perplexity error: …`**, fall back to `WebSearch` for this turn. Do NOT retry the same call. The error will already have triggered an admin alert; the user just needs an answer.

## What NOT to do

- Don't call Perplexity for a single fact you already know — wasteful and the user pays in latency.
- Don't call Perplexity twice in a row with reformulated versions of the same question — caching would catch the second call but the dispatcher won't appreciate the wait. Pick one good query and run it once.
- Don't strip the Sources section from your final reply. Citations are the entire point.
- Don't paste the full markdown answer into a Russian/English mix unless the user explicitly mixed languages — match the user's language.

## Examples

**User:** "Поищи новости про NVIDIA"
→ `mcp__perplexity__perplexity_search({ query: "Latest news about NVIDIA today", mode: "pro", language: "ru-RU" })`

**User:** "When was the last Anthropic Sonnet update?"
→ `WebSearch("latest Anthropic Claude Sonnet release date")` — simple fact, no synthesis needed.

**User:** "Open this article: https://example.com/post"
→ `WebFetch("https://example.com/post")` — known URL.

**User:** "Compare AWS Lambda cold start times to Cloudflare Workers"
→ `mcp__perplexity__perplexity_search({ query: "AWS Lambda vs Cloudflare Workers cold start latency comparison 2025", mode: "pro" })` — multi-source synthesis.
