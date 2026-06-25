# Design-Doc Rehearsal — buffr

> Coach posture. These are not study notes for you — they're the written
> artifacts you put in front of a reviewer, a teammate, or a promo committee
> to get a room to align behind a decision. Every doc here is about a
> decision **buffr actually made and shipped**. No invented decisions, no
> invented code. Where a claim is load-bearing it's cited to a real file and
> line.

The staff signal these train: at staff level the code is rarely the
bottleneck. Writing the decision down so a skeptical room aligns behind it
is. This folder is that document, for the real decisions in this repo.

---

## What warrants a design doc — and what doesn't

A design doc is expensive attention. Spend it only where the decision was
**significant and non-obvious**. The bar:

```
  warrants a doc                    skip it
  ──────────────                    ───────
  hard to reverse                   a default nobody questions
  a real alternative was on table   one obvious way to do it
  cross-cutting impact              local, contained
  someone asks "why this way?"      self-explanatory
```

buffr clears that bar in several places — it's a repo built on a string of
one-way doors (embedding dimension, where code lives, the store contract).
Here's how its decisions rank.

---

## The ranking — buffr's decisions against the bar

```
  decision                          reverse?   alt?   cross-cut?   → doc?
  ────────────────────────────────  ────────   ────   ──────────   ─────
  pgvector graduation               hard       yes    yes          ★ 01
   (in-memory RAG → persistent
    Supabase pgvector via the
    VectorStore contract)
  @aptkit/memory extraction         hard       yes    yes          ★ 02
   (memory built inline in buffr,
    extracted UP into the published
    library over the contracts)
  dropped chunks→documents FK       hard*      yes    yes          ★ 03
   (soft link, no FK — to preserve
    VectorStore drop-in parity)
  ────────────────────────────────  ────────   ────   ──────────   ─────
  trace-sink full-signal capture    medium     yes    medium       fold in
   (persist all 6 event types,
    created_at from event.timestamp)
  two-brain laptop+phone body       n/a        yes    yes          deferred
   (future RFC — design-only)
```

\* "hard" for the FK: dropping a constraint is one ALTER; the *reason* it was
dropped (contract parity) is the load-bearing, hard-to-reverse part — flip it
back and `indexDocument` breaks again.

### Why these three got full docs

- **01 — pgvector graduation.** The one-way door at the center of the repo.
  The in-memory toy became a persistent brain by filling a *contract*, not by
  rewriting the agent. A reviewer's first question is "why not a fresh
  Postgres project / why not stay in-memory / why direct `pg` and not an
  HTTP API?" — all real alternatives that were on the table. This is the doc
  that justifies the whole repo's shape. Already has a real design spec on
  disk (`docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md`);
  this rehearsal is the *defense-grade* version of it.

- **02 — @aptkit/memory extraction.** A dependency-boundary RFC. Conversation
  memory was built inline in buffr, then extracted **up** into the published
  `@rlynjb/aptkit-core` bundle as `createConversationMemory` — engine in
  aptkit, store injected by buffr. The hard part is the *boundary argument*:
  why the engine belongs in the library and the store belongs in the body.
  That's the staff-level call, and reversing it (re-inlining, or pushing the
  store up) is expensive.

- **03 — dropped chunks→documents FK.** A pure design-tradeoff writeup. The
  schema design (`sql/001_agents_schema.sql:14-27`) deliberately drops a
  foreign key everyone's instinct says to keep. The doc owns the cost
  (orphaned chunks are now possible) and names exactly what the drop buys
  (drop-in `VectorStore` parity; memory rows with no documents row). This is
  "someone will ask why" in its purest form.

### Why two got folded / deferred

- **Trace-sink full-signal capture** — `src/supabase-trace-sink.ts`. Real and
  good (all 6 `CapabilityEvent` types persisted; `created_at` from
  `event.timestamp` for deterministic replay order). But it's *contained*: it
  changes what one sink writes, not a contract or a repo boundary. A reviewer
  nods and moves on. It earns a strong paragraph in this overview and a
  callout inside doc 01 — not its own RFC. **The borderline case is itself a
  lesson:** if you can't fill the Alternatives section with two options a
  reasonable engineer would defend, it's a paragraph, not a doc.

- **Two-brain laptop+phone body** — named in `agent-layer-plan.md` and the
  graduation spec's "Out of scope." It's a *future* RFC topic, design-only:
  the persistent single-device brain (laptop) plus a deferred phone brain with
  on-device model and laptop↔phone memory sync. No code to ground it yet, so
  it's a forward-looking entry, not a shipped-decision doc. Write it when you
  build it.

---

## The design-doc template — the spine every doc here uses

One chapter = one decision = one complete doc. Same spine every time. This is
the canonical RFC shape; reuse it for any decision in this repo (or the next).

```
  THE RFC SPINE

  1. Title + one-line summary    the decision in a sentence, up top.
                                 a reader who stops here still knows the call.
  2. Context / problem           what FORCED the decision. real constraints
                                 from the repo, not theory.
  3. Goals & non-goals           what it must do — and explicitly what it
                                 won't. non-goals end scope fights before
                                 they start.
  4. The decision                the chosen design. a diagram is mandatory —
                                 the shape before the prose.
  5. Alternatives considered     2–3 REAL options that were on the table,
                                 each with why it lost. "design it twice,"
                                 written down. no alternatives = undercooked.
  6. Tradeoffs accepted          what it costs, owned without flinching
                                 ("we chose X, accepting Z"). no apology.
  7. Risks & mitigations         what could go wrong, what guards it.
  8. Rollout / migration         how it ships safely; what changes for
                                 callers / data already in flight.
  9. Open questions              what's still undecided. honesty here is a
                                 staff signal, not a weakness.
```

**Coach notes** thread through each doc — flagged inline as `Coach:` — marking
where a reviewer pushes, the framing that holds, and the sentence that gets
the yes.

---

## How to use these

- **Before a design review** — read the doc for the decision under review.
  The Alternatives and Tradeoffs sections are your answers to the first two
  questions you'll get.
- **In a promo packet** — these are the written evidence of staff-level
  judgment. Doc 02 (the dependency-boundary call) is the strongest single
  artifact: it's a decision most mid-level engineers don't even see, let
  alone write down.
- **As a template** — the spine above is reusable. The next real decision in
  this repo (the two-brain body, RLS-at-app-#2, the HTTP gateway) gets the
  same nine sections.

The discipline: own the tradeoffs without flinching, surface the open
questions honestly, and lead with the decision — never the suspense.

---

## Cross-links

- **`.aipe/rehearse-problem-selection/`** — *why* these problems deserved
  investment in the first place. Problem-selection justifies the spend before
  the design; these docs justify the *design* once the spend is approved. Read
  problem-selection first if a reviewer asks "why build this at all."
- **`.aipe/rehearse-interview-defense/`** — the *spoken* version of the same
  decisions, under live pressure. These docs are the written artifact; that
  book is how you defend it out loud when someone interrupts.
- **`.aipe/study-system-design/`** — the *comprehension* layer beneath these
  docs. Where these docs argue the decision, study-system-design walks the
  mechanism. When a doc cites the `VectorStore` seam or the trace sink, the
  deep walk lives there.
- **`.aipe/study-software-design/`** and **`.aipe/study-data-modeling/`** —
  the design-primitive and schema-shape lenses on the same code. Doc 03 (the
  dropped FK) is the same decision study-data-modeling audits as an integrity
  tradeoff.

---

## The docs

- `01-pgvector-graduation.md` — in-memory RAG → persistent Supabase pgvector,
  by filling the `VectorStore` contract.
- `02-aptkit-memory-extraction.md` — conversation memory extracted up into the
  published library; engine in aptkit, store injected by buffr.
- `03-dropped-chunks-documents-fk.md` — the deliberately-dropped foreign key,
  and what it buys.
