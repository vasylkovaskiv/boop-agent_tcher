import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { IntegrationModule } from "./integrations/registry.js";
import { perplexitySearch } from "./perplexity-client.js";

export function buildPerplexityIntegrationModule(): IntegrationModule {
  return {
    name: "perplexity",
    description:
      "Perplexity Pro Search — synthesised web answers with cited sources via Claude Sonnet thinking.",
    requiredEnv: ["ASOCKS_PROXY_URL"],
    createServer: async (ctx) => {
      const conversationId = ctx.conversationId;
      return createSdkMcpServer({
        name: "perplexity",
        version: "0.1.0",
        tools: [
          tool(
            "perplexity_search",
            `Search the web with Perplexity Pro and return a synthesised answer plus cited sources.

When to use:
- Current events, breaking news, "what's happening with X"
- Multi-source synthesis ("compare A vs B", "what do experts think about C")
- Technical research, paper summaries, in-depth comparisons
- Anything where the user asked a question that needs real-time information AND nuance

When NOT to use (prefer WebSearch / WebFetch):
- Single fact lookups (definitions, version numbers, "when did X happen")
- You already have a specific URL — use WebFetch
- Conversational replies, simple math, things you already know

Modes:
- "pro" (default): Pro Search with Claude Sonnet thinking. 5–15s. Multi-step reasoning across sources.
- "concise": Single-shot search. 3–5s. Faster + caches longer; use for simpler queries.

Output is markdown with inline references plus a "**Sources:**" section listing real URLs. The dispatcher passes the Sources section through verbatim — never paraphrase or invent URLs.`,
            {
              query: z
                .string()
                .min(1)
                .describe(
                  "The natural-language search query. Pass the user's question directly — DO NOT include system prompt text, instructions, or persona descriptions; they end up as search terms and contaminate the results.",
                ),
              mode: z
                .enum(["pro", "concise"])
                .optional()
                .describe(
                  'Default "pro" for non-trivial questions, "concise" for simple lookups.',
                ),
              language: z
                .string()
                .optional()
                .describe(
                  'BCP-47 language code, e.g. "en-US", "ru-RU". Default "en-US" — Perplexity\'s best-quality language. Pass "ru-RU" only when the user wrote in Russian and Russian-language sources are preferable.',
                ),
            },
            async (args) => {
              try {
                const result = await perplexitySearch({
                  query: args.query,
                  mode: args.mode ?? "pro",
                  language: args.language,
                  conversationId,
                });
                let text = result.answer;
                if (result.sources.length > 0) {
                  text += "\n\n**Sources:**\n";
                  result.sources.forEach((s, i) => {
                    text += `${i + 1}. [${s.title}](${s.url})\n`;
                  });
                }
                if (result.fromCache) {
                  text += "\n_(cached result)_";
                }
                return {
                  content: [{ type: "text" as const, text }],
                };
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: `Perplexity error: ${message}\n\nFall back to WebSearch / WebFetch for this turn.`,
                    },
                  ],
                };
              }
            },
          ),
        ],
      });
    },
  };
}
