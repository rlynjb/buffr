# Design Docs — buffr-laptop

The written layer. `study-*` is for you (comprehension); this is for a room
(alignment). Each doc here takes one real decision buffr already made and
writes it up the way it should be put in front of a skeptical reviewer: the
decision in the first sentence, the alternatives that lost, the cost owned
without flinching. Coach voice — "say this, not that," where a reviewer pushes
and the framing that holds.

Nothing here is invented. Every claim cites a real file. If a doc says "the FK
was dropped," there's a line number where it was dropped.

---

## Which decisions warranted a doc — and which didn't

A design doc is expensive attention. You spend it where the decision was
**hard to reverse, had a real alternative, and someone will ask "why this
way?"** Here's the ranking for this repo, and the honest cut line.

```
  buffr's decisions — ranked against the doc bar

  decision                          reverse?   alt?   cross-cut?   → verdict
  ───────────────────────────────   ────────   ────   ──────────   ────────────
  pgvector graduation               HARD       yes    yes          ★ DOC 01
   (in-memory RAG → Supabase)        (corpus    (stay  (store,
                                      + dim      mem,   schema,
                                      one-way)   other  tests,
                                                 db)    CLI)

  @aptkit/memory extraction          HARD       yes    yes          ★ DOC 02
   (built in buffr → pushed up        (lib       (keep  (two repos,
    into the published library)        API is    inline, a contract
                                       public)   own    boundary)
                                                 engine)

  dropped chunks→documents FK        medium     yes    local        fold into 01
   (preserve VectorStore parity)      (re-add    (keep  (one        (a tradeoff
                                       is a       FK,    table)      of the
                                       migration) own                graduation,
                                                  CLI)               not its own
                                                                     decision)

  full-signal trace-sink             easy       thin   local        fold into 01
   (persist all 6 event types,        (additive (drop  (one sink,   (the right
    created_at from timestamp)         column)   some   one table)   default,
                                                 events)             not an RFC)

  two-brain laptop+phone body        N/A —      —      —            deferred RFC
   (asymmetric brains, one memory)    not built  (design-only; named in Open
                                                  Questions of 01, not written)
```

Two decisions clear the bar and get a full doc. Two more are real choices but
**fold into the graduation doc as tradeoffs** rather than standing alone — the
section below says why, because knowing what *doesn't* deserve a doc is itself
the staff signal. The two-brain body isn't built yet; it lives as a forward
pointer, not a written RFC.

---

## The two that earned a doc

### 01 — The pgvector graduation

`01-pgvector-graduation.md`. The in-memory RAG pipeline became a persistent
Supabase pgvector one without the agent loop changing a line — because buffr
filled a contract aptkit already shipped. The adapter (`PgVectorStore`)
implements the port (the `VectorStore` interface); the pipeline never learns it
swapped. This is the headline architectural decision in the repo and the one a
reviewer will most want to see justified: a corpus and an embedding dimension
are hard to migrate later, so "why pgvector, why now, why this shape" is a
question worth answering on paper.

Cited to: `sql/001_agents_schema.sql`, `src/pg-vector-store.ts`,
`src/session.ts`, and the as-built design spec
`docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md`.

### 02 — The @aptkit/memory extraction

`02-memory-extraction.md`. Conversation memory was built inline in buffr, then
**extracted *up*** into the published aptkit library as `@aptkit/memory`. The
engine — embed an exchange, tag it, recall by similarity — moved into the
library over the `EmbeddingProvider`/`VectorStore` contracts; the store stays
injected by buffr. This is a dependency-boundary RFC: it decides what lives in
the reusable toolkit versus what stays in the app, and it's hard to walk back
once the library's API is public. A reviewer will ask "why does generic memory
logic live in *my* app's repo at all?" — this doc is the answer.

Cited to: `packages/memory/src/conversation-memory.ts` (in the aptkit repo),
`src/session.ts`, and `.aipe/project/context.md`.

---

## The two that did *not* — and why that's the right call

This is the teaching half of the overview. Both are real decisions. Neither
earns its own doc.

**The dropped chunks→documents FK.** A foreign key from `agents.chunks` to
`agents.documents` is the obvious, textbook-correct choice — and it was
deliberately *not* used (`sql/001_agents_schema.sql:15-27`). The reason is
load-bearing: a hard FK gives the store a hidden precondition (a `documents`
row must exist before any chunk), which breaks drop-in parity with the
`VectorStore` contract — and it also blocks memory rows, which the engine writes
as chunks with no `documents` row at all (`src/session.ts:50-53`). That's a real
tradeoff with a real alternative. But it's a tradeoff *of the graduation* — it
only exists because chunks are now persistent and contract-bound. It belongs in
01's "Tradeoffs accepted," not in a doc of its own. Splitting it out would make
the reader read two docs to understand one decision.

**The full-signal trace-sink.** The sink persists all six `CapabilityEvent`
types and sets `created_at` from the event timestamp so replay order is
deterministic (`src/supabase-trace-sink.ts:40-85`). This is the *right default*
— capturing tool-call args, durations, token usage, and errors instead of
dropping them turns `agents.messages` into a replayable trajectory. But run it
through the bar: is it hard to reverse? No — adding a column is additive. Was
there a real alternative on the table? Barely — "persist fewer events" isn't a
design anyone would argue for once trajectory capture is the goal. Will someone
ask "why this way"? Not really; it's self-explanatory once you know the goal.

This is the **borderline "fold-it, don't doc-it" case** — and naming *why* it
folds is the skill. A doc with no real losing alternative reads as undercooked.
The trace-sink's "alternative" (persist less) is a strawman, so writing it up as
a standalone RFC would manufacture suspense the decision never had. It gets one
honest paragraph in 01's rollout section instead.

```
  The cut line — what makes a decision doc-worthy

  ┌─ DOC-WORTHY ────────────────┐   ┌─ FOLD-IT ───────────────────┐
  │ real losing alternative     │   │ alternative is a strawman   │
  │ hard to reverse             │   │ additive / cheap to undo    │
  │ reviewer asks "why?"        │   │ self-explanatory given goal │
  │ → pgvector, memory-extract  │   │ → trace-sink, dropped-FK    │
  └─────────────────────────────┘   └─────────────────────────────┘
        write the full RFC               name it inside the RFC
                                         it's a tradeoff of
```

---

## The doc template (reuse this for the next decision)

Every doc here follows the canonical RFC spine. When buffr makes its next
significant decision — the phone brain, the sync model, RLS — copy this shape:

```
  1. Title + one-line summary    the decision in a sentence, up top
  2. Context / problem           the real constraint that forced it
  3. Goals & non-goals           what it must do; what it explicitly won't
  4. The decision                the chosen design + a mandatory diagram
  5. Alternatives considered     2–3 real options, each with why it lost
  6. Tradeoffs accepted          the cost, owned without apology
  7. Risks & mitigations         what breaks, what guards it
  8. Rollout / migration         how it ships safely; what changes for callers
  9. Open questions              what's still undecided (honesty = staff signal)
```

The two non-negotiables a reviewer feels immediately: the **decision is in
sentence one** (no suspense), and **section 5 has real losing alternatives**
(no doc with one option reads as designed-twice).

---

## How to use these

Read 01 before 02 — the memory extraction depends on the same
`VectorStore`/`EmbeddingProvider` contracts the graduation introduced, and 02
points back at 01 for them. Read the "fold-it" section above before you write
your *own* next doc; the discipline of not writing a doc is as load-bearing as
writing one.

```
  reading order

  00-overview  →  01-pgvector-graduation  →  02-memory-extraction
   (the cut       (the headline RFC;          (the boundary RFC;
    line)          contracts + tradeoffs)      builds on 01's contracts)
```

→ See `.aipe/study-system-design/` and `.aipe/study-data-modeling/` for the
comprehension-side walks of the same patterns — those are for understanding;
these are for the room.
