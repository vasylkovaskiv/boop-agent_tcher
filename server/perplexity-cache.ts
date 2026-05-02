import { createHash } from "node:crypto";

// Pro Search results have an implicit "freshness contract" with the user
// (the model called Pro precisely because it wanted current data) so we
// cache them only briefly — the goal is to dedupe accidental same-turn
// duplicates, not to substitute a stale answer for a deliberately fresh
// query.
const PRO_TTL_MS = 5 * 60 * 1000; // 5 minutes
const NOW_TTL_MS = 1 * 60 * 60 * 1000; // 1h
const RECENT_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const TIME_SENSITIVE_NOW = /\b(today|now|latest|breaking|current|live|just now)\b|сегодня|сейчас|последн|в данный момент/i;
const TIME_SENSITIVE_RECENT = /\b(yesterday|this week|past week|recent)\b|вчера|на этой неделе|за последнюю неделю/i;

export interface CacheKey {
  query: string;
  mode: string;
  modelPreference: string;
  language: string;
}

export function hashQuery(key: CacheKey): string {
  // Normalize whitespace; lowercase ASCII for stability across casing variants.
  // Non-ASCII characters preserve their original case — Russian "Москва" and
  // "москва" are intentionally NOT collapsed because Perplexity may return
  // different results for them and we don't want to cross-pollute.
  const normalized = key.query.trim().replace(/\s+/g, " ");
  return createHash("sha256")
    .update(`${key.mode}\0${key.modelPreference}\0${key.language}\0${normalized}`)
    .digest("hex");
}

// Heuristic TTL — longer for evergreen questions, shorter for time-sensitive
// ones. Pro mode caps at 5 min regardless because the user picked Pro to get
// current data.
export function cacheTtlMs(query: string, mode: string): number {
  if (mode === "pro") return PRO_TTL_MS;
  const lower = query.toLowerCase();
  if (TIME_SENSITIVE_NOW.test(lower)) return NOW_TTL_MS;
  if (TIME_SENSITIVE_RECENT.test(lower)) return RECENT_TTL_MS;
  return DEFAULT_TTL_MS;
}
