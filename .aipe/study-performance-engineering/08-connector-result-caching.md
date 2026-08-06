# Connector Result Caching — a TTL cache-aside decorator around every external API

**Industry name(s):** cache-aside (lazy loading); TTL cache; decorator pattern. **Type:** Industry standard.

This is the file `06-no-caching.md` said didn't need to exist. It does: every outbound connector in `/research` and `/investing` — Google Search, Reddit, RSS, Google Trends, Brave, Tavily — is wrapped in a TTL cache before it ever makes an HTTP call. This predates the current audit window but was missing from the guide; it's real, it's load-bearing for API quota, and it deserves the correction.

## Zoom out, then zoom in

External search APIs meter usage — Google gives you 100 free queries a day, Brave 2,000 a month, Tavily 1,000 a month. Ask about the same topic twice in a session — or across `/research` and `/investing` in the same session — and a naive implementation burns quota twice for identical results. buffr doesn't.

```
  Zoom out — where the cache sits

  ┌─ Session wiring (src/session.ts) ────────────────────────────┐
  │  new CachedConnector(new GoogleSearchConnector(...), cache)    │ ← we are here
  │  new CachedConnector(new RedditSearchConnector(),    cache)    │
  │  new CachedConnector(new GoogleTrendsConnector(),    cache)    │
  │     ... one per connector, shared across /research + /investing│
  └───────────────────────────┬───────────────────────────────────┘
  ┌─ Collector layer ─────────▼───────────────────────────────────┐
  │  Collector.execute() calls source.connector.fetch(params)       │
  │  — doesn't know or care whether it's cached                     │
  └───────────────────────────┬───────────────────────────────────┘
  ┌─ CachedConnector.fetch() ─▼───────────────────────────────────┐
  │  cache HIT  → return cached ConnectorResult, no HTTP call       │
  │  cache MISS → call inner.fetch(), store result, return          │
  └───────────────────────────┬───────────────────────────────────┘
  ┌─ Provider (HTTP) ─────────▼───────────────────────────────────┐
  │  Google / Reddit / Brave / Tavily / Trends — only on a MISS     │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **cache-aside with a decorator** — `CachedConnector` wraps any `DataConnector` and transparently intercepts `fetch`, so neither `Collector` nor either engine has to know caching exists. It's the same shape as `PgVectorStore` wrapping aptkit's `VectorStore` contract: an adapter that sits behind the interface its caller already depends on.

## The structure pass

Axis: **cost** — outbound API calls per repeated `(connector, params)` pair.

```
  axis = "outbound calls for the SAME query, asked twice"

  ┌─ without CachedConnector ─────────────────────────────────────┐
  │  ask 1: fetch(params) → HTTP call → quota -1                  │
  │  ask 2 (same params): fetch(params) → HTTP call AGAIN → quota -1│  ← no flip
  └─────────────────────────────────────────────────────────────┘
              ═══ buffr flips this ═══
  ┌─ with CachedConnector (buffr) ─────────────────────────────────┐
  │  ask 1: cache miss → HTTP call → quota -1 → cache.set(key, res) │
  │  ask 2 (same params): cache HIT → return cached, quota -0       │  ← flip: repeat
  └─────────────────────────────────────────────────────────────┘     input = free
```

**Seam:** `CachedConnector.fetch` (`packages/connectors/src/cached-connector.ts:21-28`) is the interception point — a seam in the exact sense the format calls out: a boundary where you can intercept a call without rewriting either side. `Collector` calls `fetch` the same way whether or not the connector underneath is cached; that's what makes it a legitimate decorator and not a special case threaded through the caller.

## How it works

### Move 1 — the mental model

You know how memoizing a pure function turns a repeated call into a map lookup? This is that, generalized to also expire after a while — because unlike an embedding, a Google Trends result for "AI note-taking apps" *should* eventually go stale. `CachedConnector` is memoization with a TTL.

```
  cache-aside — the shape

  fetch(params)
     │
     ├─ key = JSON.stringify(params)
     ├─ cache.get(key)?
     │     hit  → return immediately, no network call
     │     miss → inner.fetch(params) → cache.set(key, result, ttl) → return
     ▼
  caller (Collector) never knows which branch ran
```

### Move 2 — the load-bearing skeleton

The kernel is the whole class — it's five lines of logic (`packages/connectors/src/cached-connector.ts:10-29`):

```ts
export class CachedConnector<P, D> implements DataConnector<P, D> {
  constructor(
    private readonly inner: DataConnector<P, D>,
    private readonly cache: CacheSlot<ConnectorResult<D>>,
    private readonly ttlMs: number = 60 * 60 * 1000,   // 1 hour default
  ) {}

  async fetch(params: P, options?: FetchOptions): Promise<ConnectorResult<D>> {
    const key = JSON.stringify(params);                // ★ the cache key
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;                  // ★ short-circuit
    const result = await this.inner.fetch(params, options);
    this.cache.set(key, result, this.ttlMs);            // ★ populate on miss
    return result;
  }
}
```

Named by what breaks if removed:

- **`implements DataConnector<P, D>`** — this is what makes it a decorator instead of a special case. Any code that calls `fetch` on a `DataConnector` can't tell whether it's talking to `GoogleSearchConnector` directly or a `CachedConnector` wrapping it. Drop this and every caller needs an `if (isCached)` branch — the whole point of the pattern is gone.
- **`JSON.stringify(params)` as the cache key** — this is the load-bearing assumption: two calls are "the same request" iff their params serialize identically. It works because connector params are plain objects (query strings, counts, subreddit lists) with no functions or non-deterministic fields. **The part people forget:** key order in an object literal doesn't always round-trip identically through different code paths that build the same logical params differently (e.g., `{a:1,b:2}` vs `{b:2,a:1}` stringify to different keys) — buffr avoids this because each connector's `paramsFor()` builds params the same way every call, but it's not a structural guarantee, just a consequence of how the callers happen to be written.
- **the TTL (`ttlMs`, default 1 hour)** — without it, a cache entry never expires, so a Reddit search result from three days ago would be served forever. The TTL is what keeps the cache from silently going stale; `InMemoryCache.get` (`packages/kernel/src/cache/index.ts:14-22`) lazily evicts on read (`if (Date.now() > entry.expiresAt) delete`), so an expired-but-never-read entry just sits in the `Map` until something asks for its key again.

**Optional hardening, not skeleton:** there's no size bound or LRU eviction on `InMemoryCache` — it's a bare `Map` that only shrinks via TTL expiry on read, or when the process exits (the cache is in-memory, session-scoped, never persisted). At buffr's query volume (a handful of distinct topics per session) this is a non-issue; it would become one only if a session ran thousands of distinct queries without restarting.

**One instance per connector, shared across both engines.** `src/session.ts:459-469` hoists each `CachedConnector` (and its own `InMemoryCache`) once, then both `investingSources` and `researchSources` reference the *same* wrapped connector — the comment at `:456-458` names this explicitly: "so `investingSources`, `researchSources`, and `suggestResearchTopics()` all share one connector instance (and its cache) per provider, instead of each spinning up its own." That means a Reddit query fired by `/investing` for `$TICKER` and a coincidentally-identical query fired later by `/research` in the *same session* would hit the same cache — cross-engine cache sharing, for free, from sharing the connector instance.

```
  layers-and-hops — one cached connector, two engines

  ┌─ session.ts:468 ───────────────────────────────────────────────┐
  │  const redditConnector = new CachedConnector(new RedditSearchConnector(), new InMemoryCache(), TTL) │
  └───────┬───────────────────────────────────┬─────────────────────┘
          │ referenced by                     │ referenced by
  ┌───────▼──────────┐               ┌────────▼──────────┐
  │ investingSources  │               │ researchSources    │
  │ (src/session.ts:471)│             │ (src/session.ts:520)│
  └───────┬──────────┘               └────────┬──────────┘
          │                                    │
          └──────────── same cache, same TTL ──┘
             a repeat query from EITHER engine hits it
```

**Does it matter?** Yes, directly, for the quota-metered connectors. Google Custom Search's 100/day free tier is the tightest — every cache hit is a saved query against that ceiling. Reddit and RSS aren't quota-metered the same way, but the cache still saves a real network round-trip (audit lens 3 puts external API calls at roughly 200ms-1s+ each) on any repeated topic within the TTL window. The honest limit: it's a same-process, same-session cache — restart the CLI and it's cold again, and there's no cross-session persistence (unlike the durable `agents.chunks`/`agents.messages` tables). For a single long-running chat session, that's the right tradeoff: no persistence complexity, no staleness-across-restarts risk, and the in-session repeat case is exactly what it protects.

### Move 3 — the principle

A decorator that implements the same interface it wraps is the cheapest way to add a cross-cutting concern — caching, retries, logging — without touching either the caller or the thing being wrapped. buffr's `CachedConnector` is the textbook version: five lines, one interface, zero changes required in `Collector` or either engine to benefit from it. The general lesson: when you're about to thread a `useCache` flag through a call site, check whether the thing you're calling already sits behind an interface — if it does, a decorator is almost always cleaner than a conditional.

## Primary diagram

```
  Connector result caching — one query, cache hit vs miss

  ┌─ Collector.execute() ─────────────────────────────────────────┐
  │  source.connector.fetch(params)   ← Collector doesn't know      │
  └───────────────────────────┬───────────────────────────────────┘   this is cached
  ┌─ CachedConnector.fetch() ─▼───────────────────────────────────┐
  │  key = JSON.stringify(params)                                   │
  │  cache.get(key) ──┬── HIT  → return cached ConnectorResult      │  quota: -0
  │                    └── MISS → inner.fetch() → cache.set(key,·,TTL)│  quota: -1
  └───────────────────────────┬───────────────────────────────────┘
  ┌─ InMemoryCache (Map, session-scoped) ─────────────────────────┐
  │  TTL = 1hr default · lazy-evicted on read · no size bound       │
  └───────────────────────────────────────────────────────────────┘
  ┌─ Provider (Google/Reddit/Brave/Tavily/RSS/Trends) ─────────────┐
  │  only reached on a MISS                                          │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

Cache-aside is the most common caching pattern precisely because it requires no coordination with the write path — there is no "invalidate the cache when the source changes" problem here, because the source is a third-party API buffr doesn't control anyway; staleness is bounded purely by the TTL. This is a meaningfully easier caching problem than the one `06-no-caching.md` still describes as unsolved: caching HNSW search results would require invalidating on every new document indexed (a write buffr *does* control), which is exactly why that one is harder and still absent. The connector cache and the retrieval cache look similar on the surface — both are "same input, skip the recompute" — but they sit on opposite sides of the hard/easy line for invalidation, and that's why one exists and the other doesn't yet.

For the HTTP round-trip this cache eliminates on a hit, see **`study-networking`**. For the `DataConnector` interface `CachedConnector` implements and why every connector is swappable behind it, see **`study-system-design`**. This file owns the *what's actually cached* correction to the guide's earlier "no caching" framing.

## Interview defense

**Q: You said earlier there's no caching in this system — is that true?**

> Only for the RAG retrieval path — the embedding and HNSW search really are uncached. But every external connector — Google, Reddit, RSS, Trends, Brave, Tavily — is wrapped in a `CachedConnector` decorator with a one-hour TTL before it's handed to the collector. It's a cache-aside pattern: `fetch` checks a `Map`-backed cache keyed on the JSON-serialized params, returns on a hit, calls through and populates on a miss. Neither the collector nor either engine has to know it's there.

```
  same query, same connector, within 1hr TTL
  ask 1: MISS → HTTP call → cache.set
  ask 2: HIT  → no HTTP call, no quota spent
```

**Q: Why does this cache work but the vector-search one doesn't exist yet?**

> Invalidation. The connector cache never has to invalidate on a write buffr controls — it's a third-party API, so staleness is just "older than the TTL," a pure time-based expiry. A query-result cache over `agents.chunks` would need to invalidate every time a new document gets indexed, which is a write path buffr *does* own — that's real invalidation logic, not just a timer. I built the easy one first because the payoff was immediate: it directly protects Google's 100-query daily quota, and it was three constructor args away from every connector I already had behind a shared interface.

> Anchor: `packages/connectors/src/cached-connector.ts:10-29` (the decorator), `src/session.ts:459-469` (one instance per connector, shared across engines), `packages/kernel/src/cache/index.ts:11-30` (the TTL `Map`).

## See also

- `00-overview.md` — the caching landscape, corrected
- `audit.md` — lens 6 (caching-batching-and-backpressure)
- `06-no-caching.md` — the RAG-path cache that's still genuinely absent, and why its invalidation problem is harder than this one
- `07-connector-fan-out.md` — the concurrency layer this cache sits underneath (a cache hit skips the network call entirely, before fan-out even matters for that source)
- **`study-networking`** — the HTTP round-trip a cache hit skips
- **`study-system-design`** — the `DataConnector` interface and adapter shape
