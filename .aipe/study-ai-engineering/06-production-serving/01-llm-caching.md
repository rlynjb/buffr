# LLM caching — exact-match, semantic, and prompt cache

*Industry standard pattern; not exercised in buffr.*

## Zoom out, then zoom in

Pull up the request path and look for the place where an
identical or near-identical question could return without paying
for the model again. In buffr that place is **empty** — every
`ask()` runs the full embed → retrieve → generate path, even if
you asked the exact same thing thirty seconds ago.

```
  Zoom out — where a cache WOULD live (but doesn't)

  ┌─ CLI layer ─────────────────────────────────────────────────┐
  │  chat.tsx → session.ask(question)                            │
  └───────────────────────────┬─────────────────────────────────┘
                              │  question
  ┌─ Session layer ───────────▼─────────────────────────────────┐
  │  ★ [ CACHE WOULD GO HERE ] ★  ← nothing here today           │ ← we are here
  │   would check: seen this question before? return saved answer │
  └───────────────────────────┬─────────────────────────────────┘
                              │  cache miss (always, today)
  ┌─ Agent + Provider layer ──▼─────────────────────────────────┐
  │  embed → retrieve → gemma2:9b generate (the expensive path)  │
  └──────────────────────────────────────────────────────────────┘
```

The concept: a cache is a memo pad in front of an expensive
function. Three flavors, by how strictly they match: **exact-match**
(same string), **semantic** (similar meaning), and **prompt cache**
(provider reuses the KV state of a shared prefix). buffr has none
of them, and because it's single-user local, the simplest one —
exact-match — is also trivially correct here.

## Structure pass

**Layers:** CLI (asks) → session (where a cache would sit) →
agent/provider (the cost being avoided).

**Axis — "cost: what does a repeat question pay?"**

```
  trace "what does a repeat question cost?" across the cache seam

  ┌─ no cache (today) ─┐  seam   ┌─ with cache (Case B) ──────┐
  │ every repeat pays  │ ═══════►│ first pays · repeats free  │
  │ full embed+gen     │ (flips) │ lookup is O(1) hash hit    │
  └────────────────────┘         └────────────────────────────┘
        cost: high, every time           cost: paid once

  the cost answer FLIPS across the cache: that's the whole point
```

The seam is load-bearing only when repeats actually happen. For
a single user re-asking "what did I write about coffee," they
do. For a stream of all-unique queries, a cache is dead weight —
which is the honest reason buffr hasn't needed one yet.

## How it works

### Move 1 — the mental model

You already know this shape from the frontend: it's
`useMemo(() => expensive(input), [input])`. Same input, skip the
work, hand back the saved result. An LLM cache is that memo,
keyed on the prompt instead of a dependency array, with the
expensive function being a model call instead of a render.

```
  the cache kernel — memo in front of an expensive call

  ask(question)
     │
     ▼
  key = hash(question)        ← exact-match: the key IS the input
     │
     ▼
  hit?  ──yes──► return cached answer      (cheap)
     │
     no
     ▼
  answer = agent.answer(question)          (expensive)
     │
     ▼
  store[key] = answer ; return answer
```

### Move 2 — the step-by-step walkthrough

buffr has no cache, so Move 2 walks the *shape you would add* and
anchors it to the exact line where it attaches.

**Step 1 — pick the key, which decides the cache flavor.** The
key is everything. Exact-match hashes the raw question string —
`"how do I take coffee"` and `"How do I take coffee?"` are
different keys, so trivial wording changes miss. Semantic hashes
*meaning*: you embed the question and look for a stored embedding
within a cosine-similarity threshold. buffr already has an
embedder wired (`OllamaEmbeddingProvider`, `src/session.ts:40`),
so the semantic version is cheap to reach.

```
  exact-match vs semantic — the key is the only difference

  exact-match                 semantic
  ───────────                 ────────
  key = hash("...coffee")     key = embed("...coffee")  → vector
  lookup = map.get(key)       lookup = nearest vector
  "coffee" ≠ "Coffee?"        "coffee" ≈ "how I drink coffee"
  miss on paraphrase          hits on paraphrase
  zero false positives        risk: too-loose threshold
                              returns a wrong-but-similar answer
```

**Step 2 — the lookup wraps `agent.answer()`.** Here is the real
seam, today:

```ts
// src/session.ts:60-71 (ask) — the cache would wrap line 62
async ask(question: string): Promise<string> {
  await persistMessage(pool, conversationId, 'user', question);
  const answer = await agent.answer(question);   // ← Case B: cache around THIS
  await trace.flush();
  try { await memory.remember({ conversationId, question, answer }); }
  catch { /* swallow */ }
  return answer;
}
```

The whole insertion point is line 62. An exact-match cache is a
`Map<string, string>` checked before that line and written after
it. Nothing else in the session has to change.

**Step 3 — handle the freshness boundary (where caching bites).**
A cache is a correctness bet: you're betting the cached answer is
*still right.* It isn't, the moment the underlying corpus changes.
If you `npm run index` a new doc, every cached answer that should
now mention it is stale (cross-link
`../03-retrieval-and-rag/09-stale-embeddings.md` — same staleness
family, different layer). For buffr the safe rule is: **bust the
cache on re-index.** `src/runtime.ts indexDocumentRow` is the one
write path; clearing the cache there closes the hole.

```
  the staleness boundary — where a cache goes wrong

  cache holds:  "coffee" → "you take it black"
       │
       │  user runs: npm run index new-notes.md  (mentions oat milk)
       ▼
  cache STILL holds the old answer  ← now wrong, silently
       │
       fix: indexDocumentRow clears the cache on every write
```

### Move 2 variant — the load-bearing skeleton

Kernel of any cache: **key + store + hit/miss decision +
invalidation.**

- Drop the **key derivation** → you can't tell two requests
  apart; every lookup is a miss or a false hit.
- Drop the **store** → there's nothing to return; it's just the
  slow path.
- Drop the **hit/miss decision** → you always recompute (today's
  buffr) or always return stale.
- Drop **invalidation** → the cache outlives its correctness and
  serves wrong answers after a re-index. This is the part people
  forget, and it's where a naive cache turns into a bug.

Skeleton = key + store + decision. Invalidation + TTL + size
eviction are hardening on top.

### Move 2.5 — current state vs future state

```
  Phase A (today)              Phase B (Case B — add the memo)
  ─────────────                ──────────────────────────────
  every ask() → full path      ask() checks Map<hash, answer>
  no key, no store             hit → return saved (no model call)
  repeat questions repay       miss → run, store, return
  $0 but full latency          repeat questions are instant
                               re-index busts the cache
```

The migration cost is tiny and lives entirely in `src/session.ts`
plus one line in `src/runtime.ts`. What doesn't change: the
agent, the provider, the trace. You add a map and two checks.

### Move 3 — the principle

A cache trades memory and a freshness risk for latency and cost.
The single-user local case is the easy mode of that trade:
exact-match is provably correct (same string, same corpus, same
answer) and the only real hazard is forgetting to invalidate on
re-index. Every harder caching problem — multi-tenant key
isolation, distributed cache coherence, semantic false hits — is
this same kernel with the invalidation problem turned up.

## Primary diagram

```
  buffr caching — the dormant layer, fully drawn

  CLI:      chat.tsx → session.ask(question)
                          │
  Session:   ┌────────────▼──────────────┐
             │  key = hash(question)      │   ← Case B insertion
             │  hit? ──yes──► cached ─────┼──► return (cheap)
             │   │ no                     │
             └───┼────────────────────────┘
                 ▼
  Agent:     agent.answer(question)            ← the expensive path
                 │  embed → retrieve → gemma2:9b
                 ▼
  Session:   store[key] = answer ; return answer
                 ▲
  Index:     runtime.indexDocumentRow ─► CLEAR cache  (invalidation)
```

## Elaborate

Caching for LLMs split into three layers as the field
industrialized. **Prompt caching** (Anthropic's prompt cache,
others' KV reuse) is a provider feature — the model reuses the
attention state of a shared prefix, so a long fixed system prompt
isn't reprocessed every call; buffr can't use it because Ollama
serving Gemma locally doesn't expose it, and the win is small at
single-user scale anyway. **Semantic caching** (GPTCache and
similar) emerged to catch paraphrases that exact-match misses —
worth it at scale, risky if the similarity threshold is loose
enough to return a wrong-but-near answer. **Exact-match** is the
boring, correct baseline. For buffr the boring one is the right
one: single user, deterministic corpus, no shared key namespace
to get wrong.

## Project exercises

> No curriculum file present; exercises derived from the
> codebase. Case B — caching is not exercised in buffr today.

### Exact-match answer cache (single-user, provably correct)

- **Exercise ID:** CACHE-1 (Case B).
- **What to build:** a `Map<string, string>` keyed on a
  normalized hash of the question, checked before
  `agent.answer()` and written after; cleared whenever a doc is
  (re)indexed.
- **Why it earns its place:** demonstrates the full cache kernel
  — key, store, hit/miss, invalidation — at the difficulty where
  correctness is provable, so you can defend the invalidation
  story cleanly.
- **Files to touch:** `src/session.ts:60-71` (wrap line 62),
  `src/runtime.ts indexDocumentRow` (clear on write).
- **Done when:** asking the same question twice does the model
  call once (verified by a token-count of 0 on the second
  trace), and re-indexing forces a recompute.
- **Estimated effort:** 1–4hr.

### Semantic cache over the embedding

- **Exercise ID:** CACHE-2 (Case B — the richer version).
- **What to build:** embed the incoming question, compare against
  stored question embeddings, and return the cached answer on a
  cosine hit above a tuned threshold; reuse the existing
  `OllamaEmbeddingProvider`.
- **Why it earns its place:** forces you to reason about the
  false-positive boundary — a too-loose threshold returns a
  similar-but-wrong answer, which is the defining hazard of
  semantic caching and a great interview discussion.
- **Files to touch:** `src/session.ts` (embed + compare before
  line 62); could reuse `src/pg-vector-store.ts` to store
  question vectors.
- **Done when:** a paraphrase ("how I drink coffee" vs "how do I
  take coffee") hits, and you can show a threshold that's too
  loose producing a wrong hit.
- **Estimated effort:** 4hr–1d.

## Interview defense

**Q: buffr has no cache — is that a bug?**
Answer: no, it's a scale fit. It's single-user local with $0
per-token cost, so the only thing a cache buys is latency on
*repeat* questions, and the dataset doesn't guarantee repeats.
The honest move is to know exactly where it'd attach
(`src/session.ts:62`) and why I haven't added it.

**Q: If you added one, which flavor and what's the trap?**
Answer: exact-match first — single user, deterministic corpus, so
same string means same answer, zero false positives. The trap is
**invalidation**: a cached answer goes stale the moment I
re-index the corpus, so I'd bust the cache in
`indexDocumentRow`. **The load-bearing part everyone forgets is
invalidation** — without it the cache serves correct-looking
wrong answers after any data change.

```
  the one-liner:  same string + same corpus = same answer  ·
                  change the corpus → bust the cache, or it lies
```

## See also

- `02-llm-cost-optimization.md` — the other half of "make repeat
  work cheap"; a cache is the cheapest possible route.
- `../03-retrieval-and-rag/09-stale-embeddings.md` — the same
  staleness problem one layer down (the index, not the answer).
- `../04-agents-and-tool-use/05-agent-memory.md` — buffr's
  existing retrieval-based memory, which is cache-adjacent but
  semantic, not a hit/miss cache.
