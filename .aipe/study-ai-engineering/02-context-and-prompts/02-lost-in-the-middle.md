# Lost in the Middle

### *industry: lost-in-the-middle / position bias · type: a failure mode of long context*

## Zoom out

Same stack as the last file, but now we're looking *inside* the box, at how the model reads what's in it.

**buffr's request path, with attention behavior marked**

```
┌──────────────────────────────────────────────────────────────┐
│  RagQueryAgent          system prompt + profile-at-START       │
├──────────────────────────────────────────────────────────────┤
│  search_knowledge_base  returns chunks (minTopK: 4)            │
├──────────────────────────────────────────────────────────────┤
│  context window         8192-token box (the last file)         │
├──────────────────────────────────────────────────────────────┤
│  ★ POSITION BIAS ★      model attends to START & END,          │  ◄── this file
│                         under-reads the MIDDLE                  │
├──────────────────────────────────────────────────────────────┤
│  gemma2:9b              generates from what it actually read    │
└──────────────────────────────────────────────────────────────┘
```

Here's the uncomfortable part: fitting everything inside 8192 tokens (the last file's whole concern) is necessary but not sufficient. The model can have your answer sitting right there in the window and still miss it — because it doesn't read the window uniformly. It over-weights the beginning and the end and skims the middle. The classic name is **lost-in-the-middle**. We zoom to it now because it's the reason "it fit in the budget" doesn't mean "the model used it."

## Structure pass

The axis here is **position within the window**, and the seam is where attention drops off.

**Attention vs. position inside the window**

```
  attention
     ▲
 high│ ███                                              ███
     │ ███                                              ███
     │ ███     ░░░                              ░░░     ███
  low│ ███     ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   ███
     └──┴───────────────────────────────────────────┴──── position
       START          ◄── the MIDDLE ──►              END
       ▲                    ▲                          ▲
   profile here       buried evidence              question/
   (high slot)        (under-read)                 latest result
```

The seam is the shoulders of that curve — the points where a token stops being "near an edge" and starts being "in the middle." A fact placed at the start (buffr's profile) or end (the latest tool result, the question) gets read. The same fact dropped into a long mid-window block gets skimmed. Consequence: **how much** you put in the window changes **how well** any one piece is read. A bloated window doesn't just risk the budget — it pushes good evidence into the low-attention valley.

## How it works

### Move 1 — Mental model: a long list the reader skims

You've seen this in your own product. A 40-item list renders fine, the user reads items 1–3, scrolls, reads the last couple, and the middle is a blur. The fix was never "make the font bigger in the middle." It was: **render fewer items, and put the important one near the top.** Position bias is that, for the model.

**The model as a skimming reader**

```
  long mid-window block          short, curated set
  ┌─────────────────────┐        ┌─────────────────────┐
  │ chunk  (read)       │        │ chunk (read)        │
  │ chunk  ·            │        │ chunk (read)        │
  │ chunk  · skimmed    │        │ chunk (read)        │
  │ chunk  · valley     │        │ chunk (read)        │
  │ chunk  ·            │        └─────────────────────┘
  │ chunk  (read)       │         every item near an edge,
  └─────────────────────┘         no valley to fall into
   answer might be in the
   skimmed band ──► missed
```

Frontend bridge: virtualizing a list didn't make the list shorter — it made the *rendered* set shorter so each item got real attention. Retrieval does the same job for the context window: it shrinks the candidate set so nothing lands in the valley.

### Move 2 — Walk the defenses

buffr's mitigation for lost-in-the-middle **is retrieval itself.** Two concrete levers.

**Part A — Keep the retrieved set small (`minTopK: 4`)**

The fewer chunks you inject, the shorter the window, the less middle there is to lose things in.

**How `minTopK` bounds the set**

```
  user question ──► embed ──► ANN search over agents.chunks
                                       │
                                       ▼
                            top-k by cosine similarity
                                       │
                            k = max(requested, minTopK=4)
                                       │
                                       ▼
                            ~4 chunks ──► into the window
                            (small set = no deep middle)
```

```ts
// src/session.ts:43 — the floor on how many chunks come back
const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
```

Four chunks is a deliberate ceiling on window length, not a quality dial. With four short passages, every one sits within reach of an edge — there's barely a middle to get lost in. The temptation is to crank `topK` to 20 "for recall." That's the trap: more chunks means a deeper valley, and the model reads fewer of them *well*. Small-and-relevant beats large-and-skimmed.

**Part B — Keep each chunk short (~512 chars)**

Short chunks mean even four of them don't build a long mid-window slab.

**Chunk size and total window footprint**

```
  CHUNK_SIZE = 512 chars  (~128 tokens each)
  ┌──────┬──────┬──────┬──────┐
  │ 512  │ 512  │ 512  │ 512  │   4 chunks ≈ ~2KB ≈ ~512 tokens
  └──────┴──────┴──────┴──────┘
   small total footprint ──► stays well inside 8192,
                             and no single block is long enough
                             to bury its own tail
```

```ts
// aptkit chunker.ts:13 — the size buffr indexes at
export const CHUNK_SIZE = 512;   // ~512 chars, with overlap so facts don't straddle boundaries
```

A 512-char chunk is roughly one tight paragraph. The point: a chunk is a *unit of attention*, not a unit of storage. If you chunked at 4,000 chars, a single chunk would have its own internal middle that the model skims — you'd recreate lost-in-the-middle inside one chunk. Small chunks keep the relevant sentence near a boundary.

**Part C — Put the durable, always-relevant context at the START**

The one piece of context buffr knows is relevant every turn — the profile — goes in the highest-attention slot.

**Profile placement vs. attention**

```
  injectProfile(position: 'start')
            │
            ▼
  ┌──────────────────────────────────────────────┐
  │ PROFILE (me.md)  ◄── start = high attention   │
  │ system instructions                           │
  │ tool schemas                                  │
  │ … retrieved chunks …                          │
  │ question / latest tool result ◄── end = high  │
  └──────────────────────────────────────────────┘
```

```ts
// aptkit RagQueryAgent constructor — wired from src/session.ts:57
injectProfile(template, options.profile, { position: 'start', heading: PROFILE_HEADING });
```

This is position bias used *for* you instead of against you. The profile is the context most likely to matter on any question, so it gets the slot the model reads hardest. The same logic says the question and the freshest tool result belong at the end — and the loop naturally appends them there.

### Move 2.5 — Current vs. future

**The honest gap: buffr does NOT reorder retrieved chunks to put the best one at an edge.**

```
  TODAY                                 NOT YET EXERCISED
  ────────────────────────             ──────────────────────────────
  single-stage ANN search              two-stage: ANN recall → RERANK
  ┌──────────────────┐                 ┌──────────────────┐
  │ cosine top-4     │                 │ cosine top-N     │ (recall)
  │ order = raw      │                 │   │ rerank model  │
  │ similarity       │                 │   ▼               │
  └──────────────────┘                 │ reorder best-doc  │
   best chunk could land               │ to the EDGES      │ (precision)
   in position 2 or 3                  └──────────────────┘
   (a slight valley)                    best chunk pinned to
                                        the high-attention slot
```

buffr does **single-stage ANN only** — cosine similarity over `agents.chunks`, ordered by raw distance (`src/pg-vector-store.ts:67-85`). There is **no reranking stage** that would deliberately position the single best chunk at the start or end of the retrieved block. With only four short chunks the valley is shallow, so this rarely bites today — but it's the honest missing piece. The fix is a second-stage reranker, and it lives in `../03-retrieval-and-rag/07-reranking.md`. Note the order: you rerank *for* position, then you place — lost-in-the-middle is *why* reranking earns its cost, not a separate concern.

### Move 3 — The principle

**The model doesn't read your window; it skims it — so curate, don't dump.** Position bias means the cheapest, most reliable defense isn't a smarter prompt, it's *less* in the window and the right thing at the edges. buffr's whole retrieval design — small `minTopK`, short chunks, profile-at-start — is one coherent answer to lost-in-the-middle. Retrieval isn't only about fitting the budget; it's about keeping every surviving token in a slot the model actually reads.

## Primary diagram

The full defense, end to end.

**buffr's stand against lost-in-the-middle**

```
  question ──► embed ──► ANN search (cosine, single-stage) ──► top-4 chunks
                                                                   │
                                                                   │ (no rerank — honest gap)
                                                                   ▼
  ┌──────────────────────── 8192-token window ────────────────────────────┐
  │ PROFILE (me.md, position:'start')          ◄── HIGH attention          │
  │ system instructions + tool schemas                                     │
  │ chunk1 · chunk2 · chunk3 · chunk4   (~512 chars each, small footprint)  │
  │   └─ shallow middle: set is too short to build a deep valley           │
  │ question / latest tool result              ◄── HIGH attention          │
  └────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
              gemma2:9b reads the edges hard, the (shallow) middle lightly
```

After the box: because the set is small and the durable context sits at the start, there's little middle left to lose. The remaining precision win — pinning the single best chunk to an edge — waits on reranking.

## Elaborate

- **Why this is worse on weaker / longer contexts.** Position bias scales with how much you cram in. A near-empty window has no valley; a near-full one has a deep one. So lost-in-the-middle and the context-window budget are the same problem wearing two hats — overfilling the budget *causes* the middle to grow.
- **Overlap matters too.** buffr's chunker overlaps adjacent chunks so a fact straddling a boundary survives in at least one chunk (`aptkit chunker.ts`). Without overlap, the very sentence you need could be split across the seam between two chunks and weakened in both. Overlap is cheap insurance against boundary loss, orthogonal to position loss.
- **"Just raise topK" is the seductive wrong answer.** More chunks raises recall on paper and lowers *effective* recall in practice, because the model reads the deeper set less carefully. The right move when recall is low is better retrieval (reranking, better chunking), not a bigger dump.
- **Single-stage ANN's order is similarity, not usefulness.** Cosine-nearest isn't the same as most-useful-to-answer. That mismatch is precisely the gap a reranker closes — and the reason placement (this file) and reranking (`../03-retrieval-and-rag/07-reranking.md`) are joined at the hip.

## Project exercises

### Add a rerank-and-place stage

- **Exercise ID:** [B1.3] (cite [C1.2], Phase 1) — Case B: buffr has NO reranking today (single-stage ANN only). This is the primary target.
- **What to build:** A second-stage reranker: over-fetch (e.g. top-12 by cosine), score with a cross-encoder or an LLM-judge pass, keep the top-4, and **place the single best chunk at the start or end** of the injected block so it lands in a high-attention slot.
- **Why it earns its place:** This is the named honest gap. `src/pg-vector-store.ts:67-85` returns raw cosine order; nothing positions the best chunk for attention. Closing it directly attacks lost-in-the-middle.
- **Files to touch:** `src/session.ts` (insert the rerank step between retrieval and the tool result), `src/pg-vector-store.ts` (over-fetch path), and cross-reference `../03-retrieval-and-rag/07-reranking.md`.
- **Done when:** For a fixed query, the chunk the reranker scores highest is provably positioned at an edge of the injected block, and an eval shows answer quality holds or improves vs. raw cosine order.
- **Estimated effort:** 1–2 days.

### Probe the valley with a needle test

- **Exercise ID:** [B1.4] (cite [C1.2], Phase 1) — prerequisite eval that justifies [B1.3].
- **What to build:** A "needle in a haystack" eval: inject a known fact at start, middle, and end positions of a padded window and measure whether gemma2:9b recovers it from each position. Quantify buffr's actual valley depth.
- **Why it earns its place:** Position bias is asserted, not measured, in buffr today. You need the curve for *your* model before you can argue reranking pays for itself — measure first, then build [B1.3].
- **Files to touch:** a new eval under buffr's CLI/eval surface driving `RagQueryAgent` via `src/session.ts`; persist results through `src/supabase-trace-sink.ts`.
- **Done when:** A report shows recovery rate by position for gemma2:9b at buffr's typical window fill, and you can state how deep the middle valley actually is.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: "What's buffr's mitigation for lost-in-the-middle?"**

Retrieval itself. `minTopK:4` keeps the set small and chunks are ~512 chars, so the window stays short and there's barely a middle to lose things in. The always-relevant profile goes at the start, the highest-attention slot.

```
  small set + short chunks ─► shallow valley
  profile at START ─► durable context in the high slot
```

Anchor: *"Curate the window, don't dump into it."*

**Q: "Why not just retrieve more chunks for safety?"**

Because more chunks deepens the valley — the model reads the larger set less carefully, so effective recall drops even as nominal recall rises. The fix for low recall is better retrieval, not a bigger dump.

```
  topK 4  ─► every chunk near an edge ─► all read
  topK 20 ─► deep middle ─► chunks 6–15 skimmed
```

Anchor: *"Bigger isn't better-read."*

**Q: "Where does buffr fall short here, and what's the fix?"**

It does single-stage ANN only — raw cosine order, no reranking. So the best chunk can land in a slight valley. The fix is a second-stage reranker that scores then positions the best chunk at an edge.

```
  today:  cosine top-4, raw order
  fix:    recall top-N ─► rerank ─► place best at edge
```

Anchor: *"No rerank yet — placement is the open precision win."*

## See also

- `./01-context-window.md` — overfilling the budget is what *creates* the middle; profile-at-start lives there too.
- `../03-retrieval-and-rag/07-reranking.md` — the not-yet-built stage that pins the best chunk to an edge.
- `../03-retrieval-and-rag/` — chunking, ANN search, why retrieval is the curation layer.
- `./03-prompt-chaining.md` — splitting work is another way to keep any one window short.
