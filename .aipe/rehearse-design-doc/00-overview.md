# Design Docs — buffr-laptop

*Staff-level RFCs for the decisions in this repo that a room would actually
have to align behind. Coach voice: written so a skeptical reviewer reads it
and says yes — and so you can defend it in a promo packet or an architecture
review without re-deriving it on the spot.*

---

## What this folder is

This is the **human layer**, not the comprehension layer. `study-*` exists so
*you* understand buffr. This exists so *a room* aligns behind the calls buffr
made. At staff level the bottleneck is rarely the code — it's writing the
decision down so a reviewer, a teammate, or a promo committee can follow it
without you in the room.

So I didn't invent decisions. I ranked the ones buffr actually made, then wrote
up the ones that clear the bar — the way they *should* have been written up (and
in two cases, the way they nearly were, in `docs/superpowers/specs/`).

```
  Where this sits

  ┌─ study-* ────────────┐   understand the codebase (for you)
  │  comprehension       │
  └──────────┬───────────┘
             │
  ┌─ rehearse-design-doc ▼┐  communicate a decision in WRITING (this) ← here
  │  RFCs for a room      │
  └───────────────────────┘
```

---

## The bar — which decisions warranted a doc

A design doc is expensive attention. You spend it only where the decision was
**significant AND non-obvious**. I ranked every decision in the repo against the
four-part test and kept the ones that clear all the way to the right:

```
  buffr's decisions, ranked against the doc bar

  decision                          reverse? alt? cross-cut? "why?"  → verdict
  ─────────────────────────────────────────────────────────────────────────────
  pgvector graduation               hard     yes  yes        yes     → DOC 01
   (in-memory RAG → persistent pg)
  @aptkit/memory extraction         hard     yes  yes        yes     → DOC 02
   (inline in buffr → published lib)
  dropped chunks→documents FK       med      yes  yes        yes     → DOC 03
   (the deliberate non-default)
  ─────────────────────────────────────────────────────────────────────────────
  full-signal trace sink            easy     yes  no         mild    → FOLD (below)
   (persist all 6 event types)
  app_id default 'laptop'           easy     no   no         no      → skip
  768-dim embedding lock            hard     no   no         mild    → folds into 01
  direct pg over Edge Functions     med      yes  no         mild    → folds into 01
  768 throws, never truncates       easy     no   no         no      → skip (a guard)
```

Three docs. The spec caps at ~3, and three is exactly what clears the bar — not
a number I padded to. Everything below the line either folds into a doc that
already covers it, or is a default nobody would question.

---

## The three docs

| # | Decision | The non-obvious move |
| - | -------- | -------------------- |
| [01](01-pgvector-graduation.md) | **The pgvector graduation** | turn the in-memory RAG toy into a persistent brain by *filling an existing contract* — `PgVectorStore implements VectorStore` — instead of rewriting the agent. The schema is forward-compat for apps that don't exist yet. |
| [02](02-aptkit-memory-extraction.md) | **The @aptkit/memory extraction** | memory was built *inline in buffr*, then **extracted up** into the published aptkit library over the `EmbeddingProvider`/`VectorStore` contracts. Engine in aptkit, store injected by buffr. A dependency-boundary RFC. |
| [03](03-dropped-chunks-fk.md) | **The deliberately-dropped FK** | `chunks.document_id` has *no* foreign key — on purpose. The FK is the obvious default; keeping it would have broken `VectorStore` drop-in parity. The non-default *is* the decision. |

---

## The borderline case — why the trace sink is NOT its own doc

The spec says to teach the "fold-it, don't doc-it" line with a real borderline
case. buffr has a clean one: `src/supabase-trace-sink.ts`.

The full-signal trace sink is a **good decision** — it persists all six
`CapabilityEvent` types instead of just assistant steps, and it stamps
`created_at` from `event.timestamp` so replay order matches emit order rather
than the race between concurrent flush inserts (`supabase-trace-sink.ts:53-85`).
That last detail is genuinely staff-level: a junior writes `now()` and ships a
trajectory that reorders itself under load.

But run it against the bar and it doesn't clear:

```
  Why the trace sink folds instead of getting its own doc

  reverse?     EASY — it's an adapter behind aptkit's CapabilityTraceSink
               contract. Swap it, the agent never notices. A doc is for
               decisions you can't cheaply walk back; this you can.

  alternative? YES, but thin — "persist fewer event types" isn't a design
               fork a room argues over. It's a completeness choice, not an
               architecture one. The created_at-from-timestamp call is
               clever, but it's a one-line correctness fix, not an RFC.

  cross-cut?   NO — it's contained in one file behind one contract. Nothing
               else in the system has to change shape because of it.

  "why this?"  MILD — a reviewer nods and moves on. Nobody blocks a review
               over it.

  verdict: a paragraph in the overview + a line in DOC 03's trajectory
           tables. Not 300 lines of its own. Spending a full doc here would
           signal you can't tell a load-bearing decision from a tidy one.
```

The lesson generalizes: *an adapter behind a stable contract is almost never an
RFC.* The RFC is the **contract** and the **schema it writes into** — those are
hard to reverse and cross-cutting. The adapter that fills the contract is an
implementation detail you mention, not a decision you defend. That's why the
trace sink lives as a paragraph here and a row in DOC 03, while the *schema* it
writes into is load-bearing enough to anchor DOC 01.

---

## The template (reuse this for the next decision)

Every doc here follows the canonical RFC spine. When buffr grows its next
significant decision — the phone body, RLS, the HTTP gateway — write it up with
this exact shape:

```
  1. Title + one-line summary    the decision in a sentence, up top
  2. Context / problem           what forced it — real repo constraints
  3. Goals & non-goals           what it must do; what it explicitly won't
  4. The decision                the chosen design + a mandatory diagram
  5. Alternatives considered     2-3 real options, each with why it lost
  6. Tradeoffs accepted          what it costs, owned without flinching
  7. Risks & mitigations         what breaks, what guards it
  8. Rollout / migration         how it ships; what changes for callers/data
  9. Open questions              what's still undecided — honesty is signal
```

Two coach notes that thread through all three docs:

- **Lead with the decision, not the suspense.** The one-liner at the top is the
  whole doc compressed. A reviewer who reads only that should know what you
  chose. Build the case *after* the verdict, never toward it.
- **Own the tradeoff; don't apologize for it.** "We chose direct `pg`,
  accepting that a second client later needs the HTTP layer we deferred" reads
  as a decision. "Unfortunately we couldn't build the gateway yet" reads as a
  miss. Same fact, opposite signal.

---

## Cross-links

- The decisions trace to real specs: `docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md`
  (DOC 01), `agent-layer-plan.md` (the parent vision, DOC 02's repo-split
  thesis).
- The comprehension layer underneath these: `.aipe/study-system-design/`
  (`01-vector-store-adapter.md`, `02-library-as-dependency-boundary.md`,
  `03-trajectory-capture.md`, `07-deferred-body.md`),
  `.aipe/study-data-modeling/` (`03-soft-link-no-fk.md`,
  `06-trajectory-tables.md`), `.aipe/study-software-design/`
  (`01-adapter-behind-a-contract.md`, `03-dependency-as-a-boundary.md`).
