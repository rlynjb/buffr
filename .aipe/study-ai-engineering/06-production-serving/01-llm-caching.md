# LLM Caching

*Industry name: response caching / semantic caching / prompt caching. Type: **Language-agnostic** serving pattern.*

## Zoom out, then zoom in

The fastest LLM call, like the cheapest, is the one you never make. Caching at the serving layer is how you stop paying — in latency and compute — for an answer you already computed. Here's where the three cache layers would sit in buffr, and the honest truth is all three slots are empty.

```
buffr serving stack — the three empty cache slots
┌─────────────────────────────────────────────────────────────┐
│ chat.tsx        user types a turn                            │
├─────────────────────────────────────────────────────────────┤
│ session.ask()   ◀── ★ EXACT-MATCH CACHE would sit here       │  (empty)
├─────────────────────────────────────────────────────────────┤
│ RagQueryAgent   ◀── ★ SEMANTIC CACHE would sit here          │  (empty)
│   embed query → pgvector search → build prompt               │
├─────────────────────────────────────────────────────────────┤
│ GemmaModelProvider  ◀── ★ PROMPT CACHE (provider-side)       │  (Ollama,
│   POST /api/chat to Ollama                                   │   not used)
└─────────────────────────────────────────────────────────────┘
```

Every turn runs the whole pipeline cold: embed the question, hit pgvector, assemble the prompt, generate with `gemma2:9b`. Ask the *exact same question twice* and buffr does the *exact same work twice*. **This is Case B: no serve-time cache is implemented.** This file teaches the three layers and makes the cache the exercise. There is one piece of real caching in the system, and it is upstream of all three slots — index-time embedding reuse — which we'll name precisely so you don't over-claim.

## Structure pass — trace *what gets recomputed* across a repeated question

Pick one axis: **on a repeat question, what does buffr recompute that it didn't have to?** Trace it from input to answer.

```
repeat-question cost (buffr today) — same question asked twice
  turn 1: "what's my deploy command?"
     embed(question)  ──▶ pgvector search ──▶ gemma2:9b generate ──▶ answer
  turn 2: "what's my deploy command?"   ← byte-identical input
     embed(question)  ──▶ pgvector search ──▶ gemma2:9b generate ──▶ answer
     └── recomputed ──┘   └── recomputed ─┘   └── recomputed ────┘
  no seam: identical input, zero reuse, full price both times
```

There's no seam — that's the problem. A cached system forks at the top: a known input returns a stored answer in microseconds; a novel one falls through to the pipeline. Buffr has one road, and it repaves it every trip. The consequence is concrete: the second identical question pays one embedding call (~tens of ms) *plus* a full 9B generation (seconds on a laptop) for an answer it already produced verbatim.

## How it works

### Move 1 — the mental model: three caches keyed by how *fuzzy* the match is

The three cache layers differ on one dimension: **how loose is the key match?** Exact-match is a dictionary lookup (the key is the raw input). Semantic is a nearest-neighbor lookup (the key is the input's *meaning*, an embedding). Prompt caching is provider-internal (the key is a *prefix* of tokens already processed). Tighter match = faster + safer + lower hit rate; looser match = higher hit rate + risk of returning a "close enough" answer that wasn't.

```
the caching ladder — looser key, higher hit rate, more risk
  EXACT     key = sha(question)         hit only on byte-identical   safest
    │       lookup: O(1) dict / 1 row
  SEMANTIC  key = embed(question)        hit on "close enough" meaning
    │       lookup: nearest-neighbor, threshold gate
  PROMPT    key = shared token prefix    provider reuses KV cache    fastest, opaque
            (Ollama / vendor internal)
```

### Move 2 — the moving parts

#### Bridge: you already cache HTTP responses by URL; this is the same, keyed by question

You cache a GET by its URL and an `ETag`. Exact-match LLM caching is identical: the question string *is* the cache key, the answer is the cached body, and a hash is your `ETag`. The terminology lead is **exact-match caching (the absent input hash)** — "absent" because buffr never computes one. Where it would live is `session.ask()`, before any work starts.

Here's `session.ask()` today, with the slot marked (`src/session.ts:60–71`):

```
session.ask() today — no lookup before the work
┌──────────────────────────────────────────────────────────┐
│ async ask(question) {                                     │
│   await persistMessage(...'user', question)               │  ← logs the turn
│   ◀── EXACT-MATCH LOOKUP would go HERE (return on hit)    │  (absent)
│   const answer = await agent.answer(question)             │  ← full pipeline, always
│   await trace.flush()                                     │
│   try { await memory.remember({question, answer}) }       │  ← writes Q/A to vectors
│   catch { /* swallow */ }                                 │
│   return answer                                           │
│ }                                                         │
└──────────────────────────────────────────────────────────┘
```

The real code, verbatim:

```ts
// src/session.ts:60
async ask(question: string): Promise<string> {
  await persistMessage(pool, conversationId, 'user', question);
  const answer = await agent.answer(question);   // ← no cache guard precedes this
  await trace.flush();
  try {
    await memory.remember({ conversationId, question, answer });
  } catch { /* swallow: memory is best-effort */ }
  return answer;
}
```

#### Exact-match: a hash of the question → the stored answer

The dumbest, safest layer. Normalize the question (trim, lowercase), hash it, look it up. Hit → return the stored answer, skip everything. Miss → run the pipeline, then store `(hash → answer)`. The only correctness risk is staleness: if the indexed corpus changed, a cached answer can go wrong. The web answer applies — invalidate on write. Buffr's corpus changes only on re-index, so a cache version bumped at index time is a clean invalidation key.

```
exact-match flow (what the exercise builds)
  question ──▶ normalize ──▶ sha256 ──▶ lookup(hash)
                                          ├─ HIT  ──▶ return stored answer   (skip all work)
                                          └─ MISS ──▶ agent.answer() ──▶ store(hash, answer)
```

#### Semantic: embed the question, match on *meaning*, gate on a threshold

The looser layer, and the one buffr is *one step* from. The terminology lead is **semantic caching (nearest-neighbor over past questions)**. You already have every ingredient: an embedder, a vector store, and — critically — `createConversationMemory` already embeds every past Q/A into the same pgvector store. A semantic cache is *adjacent* to that memory: instead of recalling past exchanges to enrich context, you'd recall the *most similar past question* and, **if its similarity clears a threshold**, return that past answer directly.

```
semantic cache — reuse what conversation memory already stores
  createConversationMemory.remember({question, answer})   ← ALREADY embeds Q/A to pgvector
        (memory:conv:n rows, kind='memory', cosine-searchable)
                              │
  new question ──▶ embed ──▶ recall most-similar PAST question
                              ├─ score ≥ 0.95 ──▶ return its stored answer   (semantic HIT)
                              └─ score <  0.95 ──▶ fall through to full pipeline
```

The threshold is the whole game. Too low and you return the answer to a *different* question that merely sounded alike ("how do I deploy?" vs "how do I *undeploy*?"). Too high and you never hit. This is the one cache layer where a wrong key returns a *plausible-but-wrong* answer, so it must be conservative.

#### Prompt caching: the provider reuses the KV cache for a shared prefix

The provider-internal layer. When two requests share a long identical prefix (the system prompt, the injected profile, the same retrieved chunks), the model's attention cache (KV cache) for that prefix can be reused instead of recomputed. Buffr's prefix is *very* stable — the system template and the `me.md` profile are byte-identical every turn. Ollama can reuse this between back-to-back requests, but buffr neither configures nor measures it, so treat it as **out of buffr's hands**: a provider knob, not a buffr feature.

### Move 2.5 — current vs future

```
current (buffr today)            │  future (after the exercise)
─────────────────────────────────┼──────────────────────────────────
exact:    none                   │  sha(question) → answer, 1 pg row
semantic: memory used for CONTEXT│  memory ALSO used as a cache, threshold-gated
prompt:   Ollama default, unmeasured│ measured; stable prefix documented
re-run cost on repeat: FULL      │  exact-hit: ~1 query; semantic-hit: 1 embed + 1 search
```

The honest delta: today the only thing "cached" is the **corpus embeddings at index time** — the documents are embedded once when indexed and stored in `agents.chunks`, never re-embedded on query. That is real reuse, but it is *not* a response cache; it caches the *index*, not the *answer*. Claiming buffr "has caching" because of this would be a stretch you should not make in an interview.

### Move 3 — the principle

**A cache is a bet that the future repeats the past, and the key encodes how literally you mean "repeats."** Exact-match bets on byte-identical inputs and never lies. Semantic bets on *similar* inputs and can lie if the threshold is loose. Choose the loosest key whose lies you can tolerate — for a personal knowledge agent answering factual questions, exact-match is almost free and never wrong, so it's the one to ship first.

## Primary diagram

The whole caching story for buffr, with the live piece (index-time embedding) separated from the three empty serve-time slots:

```
buffr caching — one live reuse, three empty serve-time slots
                         INDEX TIME (offline)                 SERVE TIME (per turn)
  documents ──embed once──▶ agents.chunks                     question
              (THE live reuse:                                   │
               corpus embedded once,                  ┌── exact-match cache ──┐  (empty)
               never re-embedded on query)            │   sha(question)?      │
                                                       │     HIT → answer      │
                                                       │     MISS ▼            │
                                                       ├── semantic cache ─────┤  (empty,
                                                       │   recall similar Q?   │   memory
                                                       │     HIT → answer      │   adjacent)
                                                       │     MISS ▼            │
                                                       └── full pipeline ──────┘
                                                           embed → pgvector →
                                                           gemma2:9b (prompt cache:
                                                           Ollama's, unmeasured)
```

## Elaborate

The reason caching is **Case B and not a bug** is that buffr is a single human typing one question at a time. The repeat rate of a single user's *exact* questions is low; the latency of a cold pipeline on a local model is annoying but not a SLA breach. The economics flip the moment buffr serves a *team* (many people ask the same onboarding questions) or exposes an *API* (programmatic repeats). At that point exact-match caching is the single highest-leverage change in this whole section: it is trivial to build, never returns a wrong answer if invalidated on re-index, and removes the most expensive operation (generation) from the hot path entirely on a hit.

One trap to avoid: do not cache *retrieval* and *generation* together under one key unless you also invalidate on re-index. If you cache `question → final answer` and the corpus changes underneath, you serve a stale answer with confident citations. Either version the cache key with the index version, or cache only the cheap-to-recompute half.

## Project exercises

### Exercise: exact-match answer cache

- **Exercise ID:** [B5.1] (Phase 5, production-serving)
- **What to build:** A serve-time cache keyed by a normalized hash of the question. On `ask()`, look up `sha256(normalize(question))` in a new `agents.answer_cache` table (or a pg keyed lookup); on hit, return the stored answer and skip `agent.answer()` entirely; on miss, run the pipeline and write `(hash, answer, index_version)`. Invalidate by bumping `index_version` at re-index.
- **Why it earns its place:** It removes the most expensive operation (a full `gemma2:9b` generation) from the hot path on a repeat, can *never* return a wrong answer if invalidated correctly, and is the cleanest possible first cache. It also forces you to reason about invalidation — the hard half of caching.
- **Files to touch:** `src/session.ts` (guard at the top of `ask()`), a new `src/answer-cache.ts`, `src/migrate.ts` (the `agents.answer_cache` table), optionally `src/pg-vector-store.ts` is untouched — this is orthogonal to retrieval.
- **Done when:** Asking a byte-identical question twice produces the answer the second time with *zero* `model_usage` events in `agents.messages` (the generation was skipped), and re-indexing invalidates the cache so a changed corpus yields a fresh answer.
- **Estimated effort:** Half a day.

### Exercise: semantic cache over conversation memory

- **Exercise ID:** [B5.2] (Phase 5, production-serving)
- **What to build:** A threshold-gated semantic cache reusing the vectors `createConversationMemory` already writes. Before running the agent, embed the new question and recall the most-similar *past question*; if cosine similarity ≥ a conservative threshold (start at 0.95, tune down only with evidence), return that past answer. On miss, fall through.
- **Why it earns its place:** It is the one cache that handles *paraphrases* ("how do I deploy?" ≈ "what's the deploy command?"), and buffr is one step from it because the Q/A vectors already exist in pgvector. It teaches the threshold tradeoff that exact-match hides.
- **Files to touch:** `src/session.ts` (recall + threshold gate before `agent.answer()`), reuse `memory.recall()` from `@aptkit/memory` (already injected), no schema change needed.
- **Done when:** Two semantically-equivalent but differently-worded questions return the same answer with the second skipping generation, *and* a deliberately-similar-but-different question ("how do I undeploy?") falls through to a fresh answer — proving the threshold is conservative enough.
- **Estimated effort:** One day (the tuning is the cost, not the wiring).

## Interview defense

**Q: "Buffr re-runs the model on every turn. How would you cache, and which layer first?"**

Exact-match first, because it never lies and removes the most expensive operation on a hit. Key the cache on a normalized hash of the question, invalidate by versioning the key with the index version. Semantic caching second, gated on a conservative similarity threshold, reusing the conversation-memory vectors that already exist. Prompt caching is the provider's job, not mine. I'd ship exact-match before semantic because the failure mode of exact-match is "cache miss" (slow) while the failure mode of a loose semantic cache is "confidently wrong answer" (broken).

```
the order, and why
  EXACT first   → failure mode = miss = slow      = tolerable, ship now
  SEMANTIC next → failure mode = wrong answer      = needs threshold + evals
  PROMPT        → provider's job, measure don't build
```

*Anchor:* "Loosest key whose lies you can tolerate — exact-match's lies are just slowness."

**Q: "Doesn't indexing the embeddings already give you caching?"**

No — that caches the *index*, not the *answer*. The corpus is embedded once at index time and never re-embedded on query, which is real reuse, but every query still pays for its own query-embedding, retrieval, *and* a full generation. Index-time embedding reuse is upstream of all three serve-time cache slots; calling it "response caching" would be over-claiming.

```
index-time reuse ≠ response cache
  documents ─embed once─▶ chunks      (index cached: real)
  question  ─embed each time─▶ search ─▶ generate   (answer: NOT cached)
```

*Anchor:* "Caching the index is not caching the answer."

## See also

- `../01-llm-foundations/07-heuristic-before-llm.md` — the cheapest cache of all: skip the LLM entirely for trivial inputs.
- `../01-llm-foundations/06-token-economics.md` — the ledger a cache hit zeroes out.
- `02-llm-cost-optimization.md` — routing, the sibling lever: a cache avoids the call, routing makes the call cheaper.
- `../05-evals-and-observability/` — where a semantic-cache threshold gets validated by eval before you trust it.
