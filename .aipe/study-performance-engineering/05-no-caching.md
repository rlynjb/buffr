# No Caching (the lever not yet pulled)

*Cache-absent recompute path; memoization / result cache — Project-specific
(absence).*

## Zoom out, then zoom in

Ask buffr the same question twice and it does the same work twice: embed the
question over HTTP, run the HNSW search, feed the LLM. Nothing is *cached* between
turns. (Note: `chat` does now keep *episodic memory* — each turn's exchange is
embedded and stored for relevance-based recall on later turns via
`memory.remember`, `src/session.ts:66` — but that's a growing memory store, not a
result cache: it adds work per turn, it doesn't skip repeated work.) Here's the
path, with the box where a *cache* would sit — and currently doesn't — marked.

```
  Zoom out — where a cache would live (it doesn't)

  ┌─ Agent layer (chat.tsx → session.ts) ───────────────────────┐
  │  question string                                            │
  └─────────────────────────┬────────────────────────────────────┘
                            │
  ┌─ [ CACHE LAYER ] ───────▼────────────────────────────────────┐
  │  ★ THIS CONCEPT — a query-vector / result cache ★            │ ← we are here
  │  ┌──────────────────────────────────────────────────────┐   │
  │  │  NOT PRESENT — every ask falls straight through       │   │
  │  └──────────────────────────────────────────────────────┘   │
  └─────────────────────────┬────────────────────────────────────┘
                            │  always a miss → recompute
  ┌─ Pipeline / Provider / Storage ──▼──────────────────────────┐
  │  embed (HTTP) → HNSW search → LLM generate                  │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: a cache trades memory for recomputation — store the answer to a unit of
work keyed on its input, and skip the work on a repeat input. buffr has *no* cache
at any layer: not on the query embedding, not on the search result, not on the
profile read. This file is a pattern of *absence* — and the honest verdict is
that at single-user laptop scale, that absence is correct. The point is naming
exactly when it stops being correct.

## Structure pass

**Layers.** Three cacheable units. Two are uncached and recomputed every turn —
the *query embedding* (`embed(query)` → vector) and the *search result* (vector →
ranked chunks). The third, the *profile* (`loadProfile` → system-prompt text), is
now effectively cached at *session* granularity: `chat` reads it once at session
setup (`src/session.ts:47`) and holds it for every turn, where the old one-shot
`ask` re-read it on each invocation. So the cheapest-to-cache unit already got its
(coarse) cache for free from the long-lived session.

**Axis — cost (work repeated on a duplicate input).** Trace it:

```
  "what does a REPEAT identical ask recompute?" — traced down

  ┌───────────────────────────────────────┐
  │ query embedding: embed(question)       │   → recomputed: 1 HTTP call/turn
  └───────────────────────────────────────┘
      ┌─────────────────────────────────────┐
      │ search result: HNSW walk             │   → recomputed: 1 graph walk/turn
      └─────────────────────────────────────┘
          ┌─────────────────────────────────┐
          │ profile read: pool.query         │   → ONCE per session (session.ts:47)
          └─────────────────────────────────┘

  the two retrieval units recompute every turn — no memo short-circuits them;
  the profile is read once per session, not per turn
```

**Seam — the cache key.** The boundary a cache would insert is "input → key →
hit/miss." For the embedding, the natural key is the question string; for the
result, the same; for the profile, `app_id`. The axis "is this work done or
skipped" would flip across that key-lookup seam. buffr has no such seam — every
input is treated as novel.

## How it works

### Move 1 — the mental model

You know how `useMemo(() => expensiveCompute(input), [input])` skips the
recompute when `input` hasn't changed? A cache is that across calls instead of
across renders: hash the input, look it up, return the stored output on a hit,
compute-and-store on a miss. The strategy: **the cheapest work is the work you
don't do — remember outputs keyed on inputs and short-circuit repeats.** buffr
does none of it; every ask is a cold compute.

```
  Cache — hit/miss short-circuit (the kernel buffr lacks)

  ask("same question") ──► hash key ──► [ cache ]
                                          │   │
                                    hit ──┘   └── miss
                                     │             │
                              return stored   compute → store → return
                                     │             │
                              (skip embed +   (embed HTTP + HNSW walk)
                               HNSW walk)

  buffr: the [cache] box doesn't exist → ALWAYS the miss branch
```

### Move 2 — the moving parts

**The uncached query embedding.** Bridge: it's a `fetch` with no memo around it.
Every `ask` calls `pipeline.query(question, k)`, which embeds the question via one
`/api/embed` HTTP call (see `02-embedding-http-roundtrip.md`). Ask the identical
question twice and you make the identical HTTP call twice. Boundary condition: a
query-vector cache keyed on the *exact* question string would turn the second call
into a hash lookup — but only for *exact* repeats; near-duplicate questions
("what's the stack" vs "what stack is used") miss, because the key is the raw
string, not its meaning.

**The uncached search result.** Bridge: like calling the same API endpoint twice
and getting it to re-query the DB both times. Even given the same query vector,
`search()` re-walks the HNSW graph every call. Boundary condition: a result cache
must be *invalidated* when the corpus changes — re-index a document and a cached
result for an overlapping query is now stale. That invalidation is the hard part
of caching, and the reason absence is defensible until repeat traffic justifies
the complexity.

**The session-cached profile read.** Bridge: a config value loaded once at startup
instead of re-read per request. `loadProfile` runs a `pool.query` *once* at chat
session setup (`src/session.ts:47` → `src/profile.ts:5-6`) and the result is held
in the closure for every turn. The old one-shot `ask` re-ran it per invocation;
the long-lived session turned that into a de-facto per-session cache for free.
Boundary condition: this is the *easiest* thing to cache (rarely changes, single
row) and lowest-value (one fast indexed read) — and the long session now gets it
without any explicit cache. The trade: a profile *edited mid-session* won't be
picked up until the next session, since it's read once.

```
  What a repeat identical ask pays today vs with a cache

  TODAY (no query cache):           WITH a query cache:
    embed(question)  → HTTP           hash(question) → HIT
    search(vector)   → HNSW walk      return stored chunks
    (profile already loaded once)     (embed + search skipped)
    LLM generate     → HTTP*          *LLM still runs unless answer-cached
    memory upsert    → HTTP+SQL       (per-turn write, not a cache lookup)

  *the LLM generate dominates either way — caching embed+search helps
   retrieval latency, not the gemma2 generation that follows it
```

That last note is the honest framing: even a perfect retrieval cache doesn't help
the part that's actually slowest on a laptop — the gemma2:9b generation. Caching
here would cut embed + search, which are *already* the fast parts.

### Move 2 variant — the load-bearing skeleton

The kernel of a cache, and what breaks without each part — stated as what buffr
would need to *add*:

1. **A key derivation** — without a stable key (question string, query vector
   hash), there's nothing to look up. The key choice decides hit rate: exact
   string = low hit rate but trivially correct; semantic = higher hit rate but
   needs its own similarity threshold.
2. **A store with a bound** — an unbounded cache is a memory leak; an LRU with a
   size cap is the minimum safe store.
3. **Invalidation** — without it, a re-index leaves stale results served forever.
   This is the part that makes caching *hard* and the reason buffr's absence is a
   reasonable default, not negligence.

There's no skeleton in the code to annotate — the whole pattern is absent. Naming
what the three parts *would* be is the lesson: caching is easy to add and easy to
get subtly wrong (invalidation), which is why you add it when repeat traffic earns
it, not before.

### Move 2.5 — current state vs future state

```
  Phase A (now)                     Phase B (query-vector LRU)
  ─────────────                     ──────────────────────────
  pipeline.query(q, k)              const key = q.trim().toLowerCase()
    always embeds + searches        const hit = lru.get(key)
                                     if (hit) return hit
                                     const r = await pipeline.query(q, k)
                                     lru.set(key, r); return r

  every ask: 1 embed HTTP + 1 walk  repeat ask: 1 hash lookup
  zero memory held                  bounded LRU (cap N entries)
                                     + invalidate on re-index
```

What doesn't have to change: the pipeline, the store, the HNSW search, the embed
call. A cache is a *wrapper* you insert at the `pipeline.query` seam — it doesn't
touch anything below it. That's why it's a clean future add, not a rewrite.

### Move 3 — the principle

A cache is the highest-leverage performance move *when there's repetition to
exploit* — and dead weight (plus an invalidation bug waiting to happen) when there
isn't. Single-user, run-when-you-want buffr has almost no repeat-query pressure,
so the absence is the correct call. The discipline is to *know* it's a deliberate
absence with a named trigger (repeat traffic from multiple callers), not an
oversight.

## Primary diagram

The recompute path, every recomputed unit marked, and where a cache would cut in.

```
  Repeat-turn recompute path — what runs again every turn

  ┌─ Agent layer (chat.tsx → session.ts) ───────────────────────┐
  │  "what programming stack is used"  (asked again, same chat)  │
  └─────────────────────────┬────────────────────────────────────┘
        ░ cache would go here ░ — ABSENT, always falls through
                            ▼
  ┌─ Pipeline ───────────────────────────────────────────────────┐
  │  embed(question)  → recomputed  ── HTTP → Ollama nomic-embed  │
  │  search(vector,k) → recomputed  ── HNSW walk → Postgres       │
  └─────────────────────────┬────────────────────────────────────┘
        loaded once/session: │
  ┌─ Side reads ────────────▼────────────────────────────────────┐
  │  loadProfile → ONCE at setup (session.ts:47), not per turn   │
  └─────────────────────────┬────────────────────────────────────┘
                            ▼
  ┌─ Provider ───────────────────────────────────────────────────┐
  │  gemma2:9b generate ── the actual bottleneck, cache or not   │
  └─────────────────────────┬────────────────────────────────────┘
        per-turn write:      │
  ┌─ Memory ────────────────▼────────────────────────────────────┐
  │  memory.remember → embed + upsert  (adds work, not a cache)  │
  └──────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** There is no query/result caching code to point at — that's the
finding. The *places a cache would attach* are concrete: the `pipeline.query`
call inside the `search_knowledge_base` tool handler (reached per turn in the
agent loop). The `loadProfile` call now lives in session setup, read once.

**The uncached query path — `src/session.ts:43, 62`:**

```
  src/session.ts  (setup + per-turn answer)

  const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });  (43)
  …
  const answer = await agent.answer(question);   ← runs search per turn  (62)
        │
        └─ the tool wraps pipeline.query with no memo. Two identical questions
           in one chat = two identical embed HTTP calls + two HNSW walks. A
           cache would wrap pipeline.query here; nothing downstream changes.
```

**The session-loaded profile read — `src/session.ts:47` → `src/profile.ts:4-7`:**

```
  src/session.ts:47    const profile = await loadProfile(pool, cfg.appId);
  src/profile.ts  (lines 4-7)

  export async function loadProfile(pool, appId): Promise<string> {
    const { rows } = await pool.query(
      'select content from agents.profiles where app_id = $1
       order by updated_at desc limit 1', [appId]);  ← runs ONCE per session
    return rows[0]?.content ?? '';
  }
        │
        └─ easiest thing to cache (rarely changes, single row, clear
           invalidation on profile update), lowest value (one indexed read).
           Named for completeness, not because it's worth caching first.
```

## Elaborate

Caching is the oldest performance lever there is, and the famous hard part is
Phil Karlton's "there are only two hard things: cache invalidation and naming
things." That's not a joke in a RAG system — a result cache that doesn't
invalidate on re-index serves stale retrievals silently, which is worse than no
cache. This is precisely why adding a cache *before* you have repeat traffic is
premature: you take on the invalidation risk without the hit-rate reward.

For buffr the trigger is clear: the moment `ask` serves more than one caller, or
the same caller asks overlapping questions, a bounded query-vector LRU keyed on
the question string is the first lever — it converts the embed HTTP call + HNSW
walk into a hash lookup on a hit. What to read next:
`02-embedding-http-roundtrip.md` (the embed call a cache would skip),
`01-hnsw-approximate-search.md` (the search a cache would skip),
`study-database-systems` for cache-invalidation-on-write reasoning.

## Interview defense

**Q: There's no caching. Is that a bug?**
No — it's the correct default for a single-user, run-when-you-want CLI. There's
almost no repeat-query pressure to exploit, and a result cache without
invalidation-on-re-index would serve stale retrievals — worse than no cache. The
trigger to add one is repeat traffic; the first lever then is a bounded
query-vector LRU keyed on the question string.

```
  no repeat traffic → cache = dead weight + invalidation risk
  repeat traffic    → cache = embed HTTP + HNSW walk become a hash lookup
  add it when the trigger fires, not before
```

Anchor: the cache would wrap `pipeline.query` at the tool created in
`src/session.ts:43` (run per turn via `agent.answer`, `src/session.ts:62`);
nothing below it changes.

**Q: The part people forget?**
Invalidation. Anyone can add `lru.get(key)`. The load-bearing part is wiring
`lru.clear()` (or targeted eviction) into the *index* path — re-index a document
and any cached result overlapping it is stale. Forget that and the cache silently
serves outdated retrievals.

**Q: Would caching fix buffr's slow `chat` turn?**
Only partly, and not the slow part. Caching cuts embed + search — already the fast
units. The gemma2:9b *generation* dominates a turn's latency on a laptop, and
that's only helped by caching the full *answer*, which needs the same invalidation
care plus tolerance for stale answers. (Note the per-turn `memory.remember` embed
*adds* a round-trip rather than removing one — it's recall infrastructure, not a
cache.)

## Validate

1. **Reconstruct:** draw the cache hit/miss kernel and name the three parts buffr
   would need to add (key, bounded store, invalidation).
2. **Explain:** why is caching the *search result* harder than caching the
   *query embedding*?
3. **Apply:** wrap `pipeline.query` (reached via the tool at
   `src/session.ts:43`) in a bounded LRU. Where do you wire invalidation so a
   re-index — *or* a per-turn `memory.remember` upsert — doesn't serve stale
   results?
4. **Defend:** argue why the absence of a cache is the *correct* call today and
   name the exact condition that flips it. Then explain why per-session profile
   reuse (`session.ts:47`) is a cache, but episodic memory (`session.ts:66`) is
   not.

## See also

- `audit.md` § caching-batching-and-backpressure, § performance-red-flags (#5)
- `02-embedding-http-roundtrip.md` — the embed call a cache would skip; also the
  per-turn memory embed this file distinguishes from a cache
- `01-hnsw-approximate-search.md` — the search a cache would skip
- `04-connection-pool-reuse.md` — the session that loads the profile once
- `study-database-systems` — cache invalidation on write

---

Updated: 2026-06-24 — Reframed `ask` → `chat` turns (`session.ts`). Corrected the
profile lens: `loadProfile` now runs ONCE per session (`session.ts:47`), a
de-facto per-session cache, not a per-ask re-read. Added the distinction that
`chat`'s new episodic memory (`memory.remember`, `session.ts:66`) is recall
infrastructure that *adds* per-turn work, not a result cache. Core finding
(no query/result cache) re-verified unchanged; re-grounded anchors.
