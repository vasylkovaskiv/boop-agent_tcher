// OpenAI-compatible LLM client for non-Anthropic models routed through
// AgentRouter. Used for utility calls (email classifier, consolidation
// adversary) where the savings vs Anthropic are real and the call doesn't
// need MCP / tool-calling. The dispatcher and workers stay on the Claude
// Agent SDK because they rely on Anthropic-shaped tool-use blocks and
// prompt caching, neither of which OpenAI-compat endpoints expose well.
//
// Pricing is hardcoded per AgentRouter's published table at the time of
// writing. If they change rates we update PRICING_PER_M; the rest of the
// usage pipeline is unchanged.
import OpenAI from "openai";
import { EMPTY_USAGE, type UsageTotals } from "./usage.js";

export interface LlmRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /** Hard cap. Defaults to 1024 — utility calls return short JSON. */
  maxTokens?: number;
  /** Lower temperature => more deterministic. Defaults to 0.2. */
  temperature?: number;
}

export interface LlmResponse {
  text: string;
  usage: UsageTotals;
  durationMs: number;
}

export class AgentRouterNotConfiguredError extends Error {
  constructor() {
    super(
      "AGENTROUTER_API_KEY is not set — OpenAI-compatible models (glm-5.1, etc.) cannot be reached.",
    );
    this.name = "AgentRouterNotConfiguredError";
  }
}

let openaiClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (openaiClient) return openaiClient;
  const apiKey = process.env.AGENTROUTER_API_KEY;
  if (!apiKey) throw new AgentRouterNotConfiguredError();
  const baseURL = process.env.AGENTROUTER_BASE_URL ?? "https://agentrouter.org/v1";
  openaiClient = new OpenAI({ apiKey, baseURL });
  return openaiClient;
}

// Models that route through the OpenAI-compatible endpoint instead of
// Anthropic Messages. Add new ones here as AgentRouter expands its catalog.
const OPENAI_COMPAT_MODEL_PREFIXES = [
  "glm-",
  "gpt-",
  "deepseek",
  "qwen",
  "llama",
  "kimi",
];

export function isOpenAICompatModel(model: string): boolean {
  const lower = model.toLowerCase();
  return OPENAI_COMPAT_MODEL_PREFIXES.some((p) => lower.startsWith(p));
}

// AgentRouter's published $/M-token rates. We track separately from the
// Anthropic-side pricing the SDK reports for itself because:
//   - AgentRouter applies its own ratio multiplier on top of provider rates;
//   - the OpenAI client doesn't return a cost field, only token counts.
const PRICING_PER_M: Record<string, { prompt: number; completion: number }> = {
  "glm-5.1": { prompt: 2.051, completion: 2.051 },
  "claude-haiku-4-5-20251001": { prompt: 2.051, completion: 4.101 },
  "claude-opus-4-6": { prompt: 21.531, completion: 107.654 },
};

function priceFor(model: string): { prompt: number; completion: number } {
  const exact = PRICING_PER_M[model];
  if (exact) return exact;
  const lower = model.toLowerCase();
  for (const [key, p] of Object.entries(PRICING_PER_M)) {
    if (lower.startsWith(key.toLowerCase())) return p;
  }
  // Unknown model: emit zero cost rather than guessing. The token counts are
  // still correct, so the operator can spot-check usage from logs.
  return { prompt: 0, completion: 0 };
}

export async function callOpenAILLM(req: LlmRequest): Promise<LlmResponse> {
  const started = Date.now();
  const client = getClient();
  const completion = await client.chat.completions.create({
    model: req.model,
    messages: [
      { role: "system", content: req.systemPrompt },
      { role: "user", content: req.userPrompt },
    ],
    max_tokens: req.maxTokens ?? 1024,
    temperature: req.temperature ?? 0.2,
  });
  const text = completion.choices[0]?.message?.content ?? "";
  const inputTokens = completion.usage?.prompt_tokens ?? 0;
  const outputTokens = completion.usage?.completion_tokens ?? 0;
  const pricing = priceFor(req.model);
  const costUsd =
    (inputTokens * pricing.prompt + outputTokens * pricing.completion) / 1_000_000;
  return {
    text,
    usage: {
      ...EMPTY_USAGE,
      model: req.model,
      inputTokens,
      outputTokens,
      costUsd,
    },
    durationMs: Date.now() - started,
  };
}
