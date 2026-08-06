# No Caching (RAG Path) — an identical query re-embeds every time

**Industry name(s):** result caching / memoization; embedding cache. **Type:** Industry standard.

**Scope correction:** an earlier pass of this guide claimed there was no caching *anywhere* in buffr, including web search. That's no longer accurate — every external connector (Google, Reddit, RSS, Trends, Brave, Tavily) is wrapped in a TTL cache; see `08-connector-result-caching.md` for that mechanism. This file is narrowed to what's still true: the **RAG retrieval path** — embed → HNSW search — has no cache. Ask the same question twice, or re-run the eval set unchanged, and you pay the full embedding roundtrip and HNSW search both times. This is an *absent* mechanism; the file teaches the shape of the cache that isn't there and when it would start to matter — and, now, why this one is a harder problem than the connector cache that *does* exist.

## Zoom out, then zoom in

Caching turns "compute it again" into "look it up." buffr never makes that trade. Every query string, every time, goes the long way: embed → search → (generate).

```
  Zoom out — where a cache WOULD sit (but doesn't)

  ┌─ Session / Eval ─────────────────────────────────────────────┐
  │  query string                                                │
  └───────────────────────────┬───────────────────────────────────┘
                  ┌───────────┴── (no cache check here) ──┐
                  │  ✗ no embedding cache                  │
                  ▼                                        │
  ┌─ embed (Ollama) ──────────┐                            │
  │  always recomputed        │  ✗ no query-result cache ──┘
  └───────────┬────────────────┘
  ┌─ HNSW search ▼────────────┐
  │  src/pg-vector-store.ts:67 │  always re-run
  └────────────────────────────┘
```

Zoom in: the pattern is **result caching** — and its absence. Two cache layers could exist and neither does: an *embedding cache* (string → vector, skipping the Ollama roundtrip) and a *query-result cache* (string → hits, skipping embed *and* search). buffr has neither.

## The structure pass

Axis: **cost** — work done on a *repeated* input.

```
  axis = "cost of asking the SAME query twice"

  ┌─ first ask ─────────────────────────────────────────────────┐
  │  embed (Ollama roundtrip) → HNSW search → hits              │
  └─────────────────────────────────────────────────────────────┘
  ┌─ second ask (identical string) ─────────────────────────────┐
  │  embed AGAIN → HNSW AGAIN → same hits                       │ ← no flip
  │      ▲ a cache would flip this to: lookup → hits            │   (work repeats)
  └─────────────────────────────────────────────────────────────┘
   seam that DOESN'T exist: nothing intercepts the repeated input
```

**The missing seam:** a cache *is* a seam — a place to intercept a repeated input and short-circuit the work behind it. buffr has no such interception point. The cost axis doesn't flip on repetition because nothing notices the repetition.

## How it works

### Move 1 — the mental model

You know how memoizing a pure function — same input, cached output — turns the second call into a map lookup? An embedding is pure in exactly that sense: the same string with the same model always produces the same vector. So `embed(query)` is a textbook memoization candidate, and buffr never memoizes it.

```
  memoization — the shape that's missing

  embed("what is X?")  ── first time ──► [compute] ──► vector ──┐
                                                                │ store
  embed("what is X?")  ── again ───────► [lookup] ◄─────────────┘
                                          ▲ buffr skips this branch
                                            and recomputes every time
```

### Move 2 — the step-by-step walkthrough

**Where the recompute happens — chat.** Every `search` re-embeds upstream and re-runs the HNSW query (`src/pg-vector-store.ts:67-78`). There's no `if cached return cached` before it. The query string isn't even hashed. Two identical questions in one session are two full embed+search cycles.

**Where it bites hardest — the eval harness.** This is the concrete cost. `src/cli/eval-cmd.ts:24-31`:

```ts
for (const { query, relevant } of queries) {
  const hits = await pipeline.query(query, K);   // embed + HNSW, EVERY run
  // ... score precision / recall ...
}
```

Run the eval set today, tweak the HNSW `ef_search`, run it again to compare — every query re-embeds from scratch both runs, even though the *query strings never changed*. Only the index changed. An embedding cache keyed on `(model, string)` would make the second eval run skip every embed roundtrip and isolate the variable you're actually testing. The eval loop is where repeated identical inputs are *guaranteed*, which makes it the clearest place caching would pay.

```
  layers-and-hops — the eval re-run, with vs without an embed cache

  ┌─ eval run 1 ─────────────────────────────────────────────────┐
  │  for query: embed(Ollama) → HNSW → score                     │
  └───────────────────────────┬───────────────────────────────────┘
            tune ef_search, re-run to compare
  ┌─ eval run 2 (NOW) ────────▼───────────────────────────────────┐
  │  for query: embed(Ollama) AGAIN → HNSW → score               │ ✗ wasted embeds
  └───────────────────────────────────────────────────────────────┘
  ┌─ eval run 2 (WITH cache) ─────────────────────────────────────┐
  │  for query: cache hit → vector → HNSW → score                │ ✓ embed skipped
  └───────────────────────────────────────────────────────────────┘
```

**What a cache would cost you back.** Caching isn't free — name the trade honestly. An embedding cache needs invalidation when the model changes (key on model name, which `PgVectorStore` already tracks at `src/pg-vector-store.ts:28`). A query-*result* cache needs invalidation when the corpus changes — index a new doc and a cached hit list goes stale. That second one is the harder trade, which is exactly why the embedding cache (pure, model-keyed, no corpus dependency) is the one to reach for first.

**Correction — the web/connector tier is NOT this uncached path.** An earlier pass of this guide claimed web search tools had "no dedup, no TTL cache." That was wrong: every connector reachable from chat tools or the `/research`/`/investing` engines — Brave, Tavily, Google Search, Reddit, RSS, Google Trends — is wrapped in `CachedConnector`, a TTL cache-aside decorator with a 1-hour default, shared across engines within a session. Asking about the same topic twice inside that window costs zero outbound calls the second time. See `08-connector-result-caching.md` for the full mechanism — it's real, and it's the reason the quota numbers below (Brave: 2k/month, Tavily: 1k/month, Google: 100/day) are less exposed than they look at first glance. What's still true: it's a fresh cache per process start (session-scoped, in-memory, no persistence), so the *first* ask of a session always pays full latency, and a corpus/topic change within the TTL window still serves a stale cached result — the tradeoff that file names explicitly.

**Does it matter at laptop scale?** For the RAG path specifically — still the finding this file owns — barely, for chat: a single user rarely asks the exact same string twice in a row, so the chat hit-rate is low and unmeasured. For eval, yes — re-running the labeled set is the one workload with a *guaranteed* 100% repeat rate, and that's where an embedding cache earns the most. The connector tier no longer belongs in this "what's missing" list at all — it has its own file now, and its own, easier invalidation story (time-based only, not corpus-dependent).

### Move 3 — the principle

A cache is a bet that inputs repeat. buffr makes no such bet, which is defensible for single-user chat where they mostly don't — but leaves the one workload where they *always* repeat (eval re-runs) paying full cost every time. The general lesson: before adding a cache, ask where the repeated inputs actually are. Here they're in the eval harness, not the chat path, so that's where a cache should land first — and the embedding cache (pure function, model-keyed) is the cheap, safe one to start with.

## Primary diagram

```
  No caching — the repeated work, and where a cache would cut it

  ┌─ caller (chat OR eval re-run) ───────────────────────────────┐
  │  query string  ── (no cache check) ──►                       │
  └───────────────────────────┬───────────────────────────────────┘
        ╎ embedding cache      │  ← MISSING: string→vector, model-keyed
        ╎ would intercept here │     (pure, safe, first to add)
  ┌─ embed (Ollama) ──────────▼───────────────────────────────────┐
  │  always recomputed  ── 768-dim vector                        │
  └───────────────────────────┬───────────────────────────────────┘
        ╎ result cache         │  ← MISSING: string→hits
        ╎ would intercept here │     (harder: invalidate on corpus change)
  ┌─ HNSW search ─────────────▼───────────────────────────────────┐
  │  src/pg-vector-store.ts:67  always re-run                    │
  └───────────────────────────────────────────────────────────────┘
   biggest guaranteed-repeat workload: eval re-runs (eval-cmd.ts:24)
```

## Elaborate

Caching is the most over-applied performance pattern — added reflexively, often before there's a measured hit rate to justify it. buffr's *absence* of caching on the RAG path is arguably the correct default for a single-user chat app: you don't pay the invalidation complexity for a hit rate you haven't measured. The place that flips the calculus is the eval harness, where repeat rate is 100% by construction. The connector tier is a useful contrast case for *why* that cache shipped and this one hasn't: connector results don't need corpus-aware invalidation (`08-connector-result-caching.md`), so it was the cheap win to take first. A vector-search result cache is a strictly harder problem — it needs to invalidate every time `PgVectorStore.upsert` writes a new chunk — which is exactly why it's still absent while the easier one exists.

For the embedding model whose output would be cached and why it's deterministic, see **`study-ai-engineering`**. For the HTTP roundtrip an embedding cache would eliminate, see **`study-networking`**. For the eval harness this would most help, see **`study-testing`** (the eval seam). This file owns the *caching-tradeoff* read for the retrieval path specifically.

## Interview defense

**Q: Do you cache anything in your retrieval path?**

> Not on the RAG side — the same query embeds and searches from scratch every time, no embedding cache and no result cache. For chat that's fine: one user rarely repeats the exact string, so the hit rate would be low and I haven't measured it. Where it actually bites is the eval harness — re-running the labeled set to compare, say, two `ef_search` settings re-embeds every query both runs even though only the index changed. Worth being precise here: the *connector* tier — Google, Reddit, Trends, and friends — does have a TTL cache. That one's a separate, easier problem because it doesn't need to invalidate on anything buffr writes.

```
  same query twice → embed + search twice (no interception)
  guaranteed-repeat workload = eval re-runs → cache pays there
```

**Q: If you added one, what and where?**

> An embedding cache keyed on `(model, string)`, scoped to the eval runner first. It's a pure function — same model, same string, same vector — so no corpus-change invalidation, just bust it when the model name changes, which the store already tracks. I'd avoid a query-*result* cache initially because that one goes stale every time I index a doc, and that invalidation is the harder, more bug-prone trade — the same reason the connector cache I already shipped was the easy one and this is the one still on the list.

> Anchor: `src/pg-vector-store.ts:67` (re-embeds + re-searches), `src/cli/eval-cmd.ts:24-31` (the guaranteed-repeat loop).

## See also

- `00-overview.md` — finding #5
- `audit.md` — lens 6 (caching), lens 8 (red flags)
- `01-hnsw-approximate-search.md` — the search a result cache would skip
- `02-embedding-roundtrip.md` — the embed an embedding cache would skip
- `08-connector-result-caching.md` — the cache that DOES exist, and why its invalidation story is easier than this one
- **`study-ai-engineering`** — the deterministic embedding model
- **`study-testing`** — the eval harness where caching pays most
