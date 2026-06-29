# No Caching

**Industry names:** memoization · embedding cache · result cache · the absent cache layer.
**Type:** Industry standard (studied here by its *absence*).

---

## Zoom out, then zoom in

Embeddings are deterministic: the same text through the same model gives the same 768-dim
vector, every time. buffr never exploits that. The same question typed twice re-embeds
twice; the eval harness re-embeds every labeled query on every run. There's no cache
anywhere — not for embeds, not for query results. This file studies the cache buffr
*doesn't* have, because the absence is the finding.

```
  Zoom out — where a cache would sit, and doesn't

  ┌─ Session / CLI layer ───────────────────────────────────────┐
  │  ask(q)  /  pipeline.query(q)                                │
  │     │                                                        │
  │     ▼   ┌─ ✗ NO CACHE HERE ✗ ────────────────────┐          │ ← we are here
  │     │   │  (deterministic embed(q) recomputed     │          │   (the gap)
  │     │   │   every call)                           │          │
  │     │   └─────────────────────────────────────────┘          │
  │     ▼                                                        │
  └─────┼────────────────────────────────────────────────────────┘
        │ embed │ HTTP :11434 (every time)
  ┌─ Ollama ───▼──────────────────────────────────────────────────┐
  │  nomic-embed-text:v1.5 — recomputes the same vector on repeat  │
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is a **missing memoization layer** over a deterministic, idempotent
function. The question this file answers: what is recomputed that could be cached, how
trivially cacheable it is, and why "no cache" is — for now — the right call anyway.

---

## Structure pass

**Layers.** The cacheable work lives at one layer: embedding. Two call sites recompute it —
the chat path (`session.ts`, via `agent.answer` → query embed) and the eval path
(`eval-cmd.ts:26`, `pipeline.query` per labeled query).

**Axis — cost (redundant recomputation).** Hold "is this work repeated for identical input?":

```
  One question — "is identical work recomputed?" — across the call sites

  ┌─ chat turn (session.ts) ────────────────────────────┐
  │  same question twice → embed(q) computed TWICE       │  redundant, cacheable
  └──────────────────────────────────────────────────────┘
  ┌─ eval run (eval-cmd.ts) ────────────────────────────┐
  │  re-run the suite → every query re-embedded          │  redundant across runs
  └──────────────────────────────────────────────────────┘
  ┌─ the embed function itself ─────────────────────────┐
  │  pure for fixed (model, text) → SAME vector out      │  ← the cacheable property
  └──────────────────────────────────────────────────────┘

  the function is pure; the call sites don't dedupe. that's the whole gap.
```

**Seam — the call boundary at `embed(text)`.** The load-bearing seam is the embed call
itself: a deterministic function with no memo wrapper. A cache slots in *exactly here* — key
on `(model, text)`, return the stored vector on hit. Nothing else in the system needs to know
the cache exists; it's a transparent interposition at one seam.

---

## How it works

### Move 1 — the mental model

You know `useMemo(() => expensive(input), [input])` — recompute only when the input changes,
otherwise hand back the stored result? A cache for embeddings is exactly that, keyed on the
text. buffr has the perfect candidate for it (a pure function over text) and the wrapper
nowhere. The mental model: **a deterministic function called repeatedly with repeating
inputs, and no memo between the call and the computation.**

```
  Cache — the interposition that isn't there

  WITHOUT (now):
    embed("what is X") ──► Ollama ──► [vector]   ← every call, full HTTP + GPU
    embed("what is X") ──► Ollama ──► [vector]   ← again, identical work

  WITH (a Map keyed on text):
    embed("what is X") ──► cache MISS ──► Ollama ──► store ──► [vector]
    embed("what is X") ──► cache HIT  ──────────────────────► [vector]   ← no HTTP, no GPU
```

### Move 2 — the walkthrough

**Where the redundant embed lives, on the chat path.** Each `ask()` runs the agent, which
embeds the query to search. `session.ts:60-71` calls `agent.answer(question)` fresh every
turn — no dedupe. Ask the same thing twice in a session and the query is embedded twice,
each a full Ollama HTTP roundtrip plus GPU dispatch. And recall from `05`: `memory.remember`
adds a *second* embed per turn — also uncached.

**Where it's most obviously wasteful — the eval harness.** `eval-cmd.ts:24-32`:

```ts
for (const { query, relevant } of queries) {
  const hits = await pipeline.query(query, K);   // ← embeds `query` EVERY run, from scratch
  ...
}
```

The eval set (`eval/queries.json`) is *fixed*. Every time you run `npm run eval` to check
whether a tuning change helped, every labeled query is re-embedded from zero. The inputs
never change between runs — this is the textbook case for a persistent embed cache, and it's
the place the absence stings most because eval is the loop you run *repeatedly* while tuning.

**The cache that isn't there — the skeleton of the fix:**

```
  pseudocode — the embed memo (the missing layer)

  cache = Map<string, number[]>            // key: `${model}:${text}`, value: the vector
  function cachedEmbed(text):
    key = model + ":" + text
    if cache.has(key):                     // HIT — no HTTP, no GPU
      return cache.get(key)
    vector = ollamaEmbed(text)             // MISS — pay once
    cache.set(key, vector)                 // store for next time
    return vector

  in-process Map for a session; a `embeddings` table or Redis to persist across runs.
```

**What breaks without it — and why that's fine here:**

```
  no-cache consequences — named, then judged

  1. repeated query re-embeds      → wasted HTTP+GPU on dup input    cost: low (rare dups)
  2. eval re-embeds every run      → slow tuning loop                cost: low-moderate
  3. memory embed never deduped    → second embed per turn always    cost: low (dwarfed)
  ── but ──
  no cache = no invalidation, no staleness, no extra moving part     benefit: simplicity
```

**Does it matter at laptop scale? No — and that's why it's correct for now.** A cache buys
you nothing on *cold* queries (every new question is a miss), and buffr's traffic is one
user asking mostly-novel questions. The hit rate on real chat would be low. The one place a
cache clearly pays is the eval loop — fixed inputs, run repeatedly — and even there it's
seconds saved, not a capability unlocked. Meanwhile a cache *adds* a moving part: an
invalidation story, a memory ceiling, a staleness question if the model version changes. At
this scale the simplicity of "always recompute, never stale" is worth more than the
milliseconds a cache would save. The honest verdict: **no-cache is the right call today, and
the first cache to add — when it's worth it — is a persistent embed cache for the eval loop.**

### Move 2.5 — current state vs future state

```
  Phase A — now (no cache)              Phase B — embed cache (when it pays)
  ────────────────────────────          ─────────────────────────────────────
  every embed recomputed                Map (session) or table/Redis (cross-run)
  zero staleness, zero invalidation     key on (model, text); invalidate on model change
  simple; correct; fine for 1 user      eval loop stops re-embedding fixed queries
  + low-dup chat traffic                cost: an invalidation + memory-bound story
```

What *doesn't* change: the embedder, the store, the search. The cache is a transparent
wrapper at one seam — `embed(text)` — and nothing downstream knows it's there.

### Move 3 — the principle

A cache is only worth its invalidation cost when the hit rate is high enough to pay for the
complexity. The discipline isn't "always cache deterministic work" — it's "measure the hit
rate first." buffr's chat traffic is mostly-novel (low hit rate → skip), its eval loop is
fixed-input (high hit rate → the one place to cache). Knowing the difference is the lesson;
adding a cache everywhere a pure function exists is the mistake the absence here avoids.

---

## Primary diagram

```
  No caching — the recompute that repeats, and where a memo would slot in

  ┌─ Call sites ──────────────────────────────────────────────────────┐
  │  chat:  ask(q) → agent.answer → embed(q)   ← recomputed per turn    │
  │  memory: remember → embed(exchange)        ← second embed per turn  │
  │  eval:  pipeline.query(q) per labeled query ← re-embedded per RUN   │
  └──────────────────────────────────┬────────────────────────────────┘
                                      │
              ┌───────── ✗ NO CACHE (the gap) ✗ ─────────┐
              │  would key on (model, text); HIT → return │
              │  stored vector, skip HTTP + GPU entirely  │
              └──────────────────────────┬────────────────┘
                                         │ embed │ HTTP :11434 (every time)
  ┌─ Ollama: nomic-embed-text:v1.5 ─────▼──────────────────────────────┐
  │  deterministic: same text → same vector → safe to cache            │
  │  best ROI: the fixed-input eval loop (eval-cmd.ts:26)              │
  └────────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Caching is the canonical "make it faster by not doing the work twice," and embeddings are an
unusually clean target because they're pure and idempotent — no invalidation needed unless
the model version changes. The reason buffr *doesn't* have one is the right reason: a cache
is a liability when the hit rate is low (it's pure overhead + a staleness surface), and chat
queries are mostly unique. The eval harness is the exception worth carving out — fixed inputs
run on every tuning iteration, exactly the high-hit-rate shape a cache wants.

This connects to `01-hnsw-approximate-search` (the eval loop that re-embeds is the same loop
you'd use to verify an HNSW tuning change — caching its embeds makes that verification loop
tight) and `05-per-turn-memory-and-trace-cost` (the per-turn second embed is one more
uncached deterministic call).

---

## Interview defense

**Q: Embeddings are deterministic. Why don't you cache them?**

Because the hit rate doesn't justify it — yet. Chat traffic is mostly-novel questions, so a
cache would mostly miss and just add an invalidation surface and a memory ceiling for no
real saving. A cache is only worth its complexity when the hit rate is high.

```
  chat queries:  mostly unique → low hit rate → cache = overhead   → skip
  eval queries:  fixed set, re-run → high hit rate → cache pays     → the one to add
```

The place it *does* pay is the eval loop (`eval-cmd.ts:26`): the labeled query set never
changes, but every run re-embeds all of it from scratch. A persistent embed cache keyed on
`(model, text)` would make that tuning loop tight. So my answer isn't "caching is bad" — it's
"I measured where the hit rate is, and the first cache I'd add is a persistent embed cache for
eval, not a general one for chat." The invalidation story is easy too: bust on model-version
change, since that's the only thing that alters the output.

**Anchor:** `eval-cmd.ts:24-32` (re-embeds every run), `session.ts:60-71` (per-turn embed,
uncached). The cache is absent by design, not by oversight.

---

## See also

- `02-embedding-roundtrip.md` — the embed roundtrip that a cache would skip on a hit.
- `01-hnsw-approximate-search.md` — the eval loop (uncached embeds) is the tuning gauge.
- `05-per-turn-memory-and-trace-cost.md` — the per-turn second embed, also uncached.
- `audit.md` §6 (caching absent), §2 (eval as the repeated loop), §8 (red flag #4).
- `study-ai-engineering` — embeddings and the retrieval pipeline these calls go through.
