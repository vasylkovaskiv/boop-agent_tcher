import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

// Server-side session memory on Perplexity expires after ~1 hour. Keep the
// stored window slightly conservative so a stale UUID never gets reused.
const SESSION_TTL_MS = 55 * 60 * 1000;

// ---------- State (cookies + health) ----------

export const getState = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("perplexityState"),
      _creationTime: v.number(),
      cookies: v.string(),
      userAgent: v.string(),
      timezone: v.optional(v.string()),
      lastRefreshedAt: v.number(),
      lastSuccessAt: v.optional(v.number()),
      lastErrorAt: v.optional(v.number()),
      lastError: v.optional(v.string()),
      consecutiveFailures: v.number(),
      remainingProSearches: v.optional(v.number()),
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db.query("perplexityState").take(1);
    return rows[0] ?? null;
  },
});

export const updateCookies = mutation({
  args: {
    cookies: v.string(),
    userAgent: v.string(),
    timezone: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("perplexityState").take(1);
    const now = Date.now();
    if (existing[0]) {
      await ctx.db.patch(existing[0]._id, {
        cookies: args.cookies,
        userAgent: args.userAgent,
        timezone: args.timezone,
        lastRefreshedAt: now,
        consecutiveFailures: 0,
        lastError: undefined,
        lastErrorAt: undefined,
      });
    } else {
      await ctx.db.insert("perplexityState", {
        cookies: args.cookies,
        userAgent: args.userAgent,
        timezone: args.timezone,
        lastRefreshedAt: now,
        consecutiveFailures: 0,
      });
    }
    return null;
  },
});

export const recordSuccess = mutation({
  args: {
    remainingProSearches: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("perplexityState").take(1);
    if (!rows[0]) return null;
    await ctx.db.patch(rows[0]._id, {
      lastSuccessAt: Date.now(),
      consecutiveFailures: 0,
      lastError: undefined,
      lastErrorAt: undefined,
      ...(args.remainingProSearches !== undefined
        ? { remainingProSearches: args.remainingProSearches }
        : {}),
    });
    return null;
  },
});

export const recordFailure = mutation({
  args: {
    error: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("perplexityState").take(1);
    if (!rows[0]) return null;
    await ctx.db.patch(rows[0]._id, {
      lastErrorAt: Date.now(),
      lastError: args.error,
      consecutiveFailures: rows[0].consecutiveFailures + 1,
    });
    return null;
  },
});

// ---------- Cache ----------

export const getCachedResult = query({
  args: { queryHash: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("perplexityCache")
      .withIndex("by_hash", (q) => q.eq("queryHash", args.queryHash))
      .unique();
    if (!row) return null;
    if (row.expiresAt < Date.now()) return null;
    return row.result;
  },
});

export const recordCacheHit = mutation({
  args: { queryHash: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("perplexityCache")
      .withIndex("by_hash", (q) => q.eq("queryHash", args.queryHash))
      .unique();
    if (!row) return null;
    await ctx.db.patch(row._id, { hits: row.hits + 1 });
    return null;
  },
});

export const cacheResult = mutation({
  args: {
    queryHash: v.string(),
    query: v.string(),
    mode: v.string(),
    result: v.string(),
    ttlMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("perplexityCache")
      .withIndex("by_hash", (q) => q.eq("queryHash", args.queryHash))
      .unique();
    const now = Date.now();
    const expiresAt = now + args.ttlMs;
    if (existing) {
      await ctx.db.patch(existing._id, {
        result: args.result,
        createdAt: now,
        expiresAt,
        // Preserve hits count so the cache row's popularity survives refreshes.
      });
    } else {
      await ctx.db.insert("perplexityCache", {
        queryHash: args.queryHash,
        query: args.query,
        mode: args.mode,
        result: args.result,
        createdAt: now,
        expiresAt,
        hits: 0,
      });
    }
    return null;
  },
});

// Reaper for expired cache rows. Bounded by `batchSize` so a single mutation
// stays inside Convex's per-transaction read/write limits — call repeatedly
// (e.g. from a periodic action) until `deleted < batchSize`.
export const cleanupExpiredCache = mutation({
  args: { batchSize: v.optional(v.number()) },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx, args) => {
    const limit = Math.min(args.batchSize ?? 100, 500);
    const now = Date.now();
    const expired = await ctx.db
      .query("perplexityCache")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", now))
      .take(limit);
    for (const row of expired) {
      await ctx.db.delete(row._id);
    }
    return { deleted: expired.length };
  },
});

// ---------- Sessions (last_backend_uuid per conversation) ----------

export const getSession = query({
  args: { conversationId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      backendUuid: v.string(),
      lastUsedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("perplexitySessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();
    if (!row) return null;
    // Don't return stale sessions — Perplexity 4xx's on expired UUIDs which
    // would surface as a confusing user-facing error. Caller falls back to a
    // fresh turn (`last_backend_uuid: null`).
    if (Date.now() - row.lastUsedAt > SESSION_TTL_MS) return null;
    return { backendUuid: row.backendUuid, lastUsedAt: row.lastUsedAt };
  },
});

export const setSession = mutation({
  args: {
    conversationId: v.string(),
    backendUuid: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("perplexitySessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        backendUuid: args.backendUuid,
        lastUsedAt: now,
      });
    } else {
      await ctx.db.insert("perplexitySessions", {
        conversationId: args.conversationId,
        backendUuid: args.backendUuid,
        lastUsedAt: now,
      });
    }
    return null;
  },
});

export const clearSession = mutation({
  args: { conversationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("perplexitySessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    return null;
  },
});
