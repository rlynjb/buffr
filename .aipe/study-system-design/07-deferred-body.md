# Deferred Body

**Industry names:** YAGNI with forward-compat seams · evolutionary
architecture · "build for today, schema for tomorrow" · Project-specific
(the single-device-now / two-brain-later thesis)

## Zoom out, then zoom in

buffr is deliberately *half a system*. It ships single-device persistence and
nothing else — no HTTP API, no RLS, no phone, no sync, no fine-tuning. But it
isn't naive about the rest: every deferred phase is *named*, and the schema +
the `VectorStore` contract are shaped so those phases reuse them with **no
rework**. The whole pattern is "ship the smallest correct thing, but leave the
exact seams the future needs already cut." This is the architectural thesis of
the repo — `v1b` of a deferred body.

```
  Zoom out — what's built vs what's a named seam

  ┌─ BUILT NOW (single device) ──────────────────────────────────┐
  │  pg direct · agents schema · PgVectorStore · trace capture    │
  │  index/ask/eval CLI · 768 embeddings · app_id columns         │
  └──────────────────────────┬───────────────────────────────────┘
                             │  reuses, no rework ▼
  ┌─ DEFERRED (named, not built) ────────────────────────────────┐
  │  Edge Functions / HTTP API   RLS + token-derived app_id       │
  │  the phone (RN, on-device)   laptop↔phone sync   tool cache   │
  │  trajectory → fine-tune      multi-app gateway                │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **YAGNI applied to behavior, forward-compat applied to
data**. You don't build the phone, but you do put `app_id` / `user_id` /
`embedding_model` columns in now, because they're cheap today and a painful
migration later. Strip this discipline and you get one of two failures:
over-build (an HTTP API and RLS for a single local user) or paint-into-a-corner
(a schema with no `app_id`, forcing a migration the day app #2 arrives).

## Structure pass

**Layers** — built code (CLIs, adapters, schema) → the seams (contract +
columns) → the deferred phases that hang off the seams.

**Axis: built or deferred — and what makes the deferral safe?** Trace it.

```
  One question: "is this built, and if not, why is deferring it safe?"

  ┌──────────────────────────────────────────────┐
  │ behavior (HTTP API, sync, phone): NOT built    │ → deferred, no caller yet
  └───────────────────────┬──────────────────────┘
      ┌───────────────────▼──────────────────────┐
      │ data seams (app_id, embedding_model col):  │ → built NOW (cheap),
      │ BUILT now even with one tenant             │   reused later (no migration)
      └───────────────────┬──────────────────────┘
          ┌───────────────▼──────────────────────┐
          │ contract (VectorStore): BUILT, stable │ → swap body, contract holds
          └───────────────────────────────────────┘

  behavior is deferred; the seams behavior will need are built — that asymmetry
  is the entire pattern
```

**Seam.** The load-bearing seams are exactly the two that make future phases
free: the `agents` schema's forward-compat columns and the `VectorStore`
contract. The property that flips across the deferral boundary: today these
seams are *unused capacity* (one tenant, one body); tomorrow they're the
*attachment points* for RLS and the second body — and nothing built today has
to change for that.

## How it works

### Move 1 — the mental model

You know how you add a nullable `deleted_at` column before you build soft-
delete, because adding the column to a populated table later is the expensive
part? The deferred body is that instinct applied to a whole architecture: pour
the foundation slab wide enough for the house you're not building yet, because
the slab is cheap now and impossible to widen once the walls are up.

```
  the pattern — defer behavior, pre-cut the seams

  TODAY:  [ built: minimal correct system ]
              │ with seams already cut:
              ├─ app_id column (1 tenant)         → RLS attaches here later
              ├─ embedding_model column           → reindex attaches here later
              ├─ VectorStore contract             → new body attaches here later
              └─ trace capture (no consumer)       → fine-tune attaches here later
  LATER:  attach the deferred phase to a pre-cut seam → no migration, no rework
```

### Move 2 — the load-bearing skeleton

Four seams carry the deferral. Each named by what *future* breaks without it.

#### Seam 1 — app_id everywhere (the RLS / multi-tenant hook)

Every table has `app_id` with a `'laptop'` default, even though there's one
tenant. Today it's a constant from config; tomorrow it's the column RLS
policies and token-derived isolation attach to.

```
  app_id — unused isolation capacity, built now

  today:   every row app_id='laptop'   (filter is effectively a no-op)
  app #2:  RLS USING (app_id = jwt.app_id)  ← attaches to the EXISTING column
       │
       └─ what breaks without it: adding app_id to a populated chunks/messages
          table later is a migration + backfill. The column is cheap now,
          painful to retrofit. (design doc: "cheap now, painful to retrofit")
```

#### Seam 2 — the VectorStore contract (the swap-the-body hook)

The agent depends on the `VectorStore` interface, not on Postgres
(`01-vector-store-adapter.md`). That's what lets the *body* change — laptop pg
today, phone SQLite or edge-function-fronted pg tomorrow — with the agent
untouched.

```
  the contract — swap the body, keep the brain

  RagQueryAgent → VectorStore (stable port)
                       ▲
       ┌───────────────┼────────────────┐
   PgVectorStore   (future) phone store  (future) HTTP-fronted store
       │
       └─ what breaks without the contract: every new body forces an agent
          rewrite. With it, the deferred phone/edge phases reuse the agent as-is.
```

#### Seam 3 — embedding_model column (the reindex / one-way-door hook)

`chunks.embedding_model` records *which* model produced each vector. Today
it's always `nomic-embed-text:v1.5`. Tomorrow, swapping embedders (768 →
1536) means re-embedding the corpus, and this column is how a `reindex` knows
what's stale.

```
  embedding_model — the named one-way door

  today:   every chunk embedding_model='nomic-embed-text:v1.5'
  swap:    reindex(embedder) re-embeds rows where embedding_model != new model
       │
       └─ what breaks without it: a model swap can't tell old vectors from new,
          so you can't drive a targeted reindex. The design names reindex as
          first-class (design doc line 154) — built as a seam (column), not yet
          as code (the function). Honest: column = yes, reindex() = not yet.
```

#### Seam 4 — trajectory capture with no consumer (the fine-tune hook)

Every conversation is written to `agents.messages` now, even though *nothing
reads them back as training data*. The capture is the seam; the fine-tune is
the deferred phase that may or may not ever attach to it — gated on Phase-4
eval evidence.

```
  trajectory capture — write now, decide later

  every ask → messages rows (history + debugging today)
                  │
                  ▼  (deferred, gated)
            fine-tune dataset  ─── ONLY IF Phase 4 eval numbers demand it
       │
       └─ what breaks without capturing now: the day you want to fine-tune, you
          have no data — and you can't retroactively capture past conversations.
          Capture is cheap; not having the data is fatal. (agent-layer-plan.md)
```

### Move 2.5 — current state vs future state

The clearest way to see the pattern is the built/deferred split, side by side.

```
  Phase A (built — buffr v1b)      vs   Phase B (deferred — named)

  pg direct from CLI                    Edge Function / supabase-js HTTP API
  app_id from config (1 tenant)         app_id from JWT + RLS on every table
  one body (laptop pg)                  + phone (RN, on-device) + sync
  index synchronously                   batch reindex past ~10k chunks
  trace captured, unread                trace → LoRA fine-tune (if Phase 4 says)
  ────────────────────────────          ──────────────────────────────────────
  WHAT CHANGES to get from A to B:  attach to pre-cut seams.
  WHAT DOESN'T CHANGE:              the schema, the VectorStore contract,
                                    the agent, the trace capture. That's the win.
```

The takeaway is *what doesn't have to change*. Every Phase-B item attaches to a
seam that already exists in Phase A. No phase forces a rewrite of what's built
— that's the test the deferral passed.

### Move 3 — the principle

Defer the *behavior* you don't need; build the *seams* that behavior will need.
The asymmetry is the discipline: code that does nothing today (an HTTP handler,
an RLS policy) is YAGNI and stays unbuilt, but data shape that's expensive to
change later (a column, a contract) gets built now while it's cheap. You earn
the right to ship half a system by being precise about which half, and by
leaving the other half's attachment points already cut.

## Primary diagram

The full built-vs-deferred map, every deferred phase pointing at its seam.

```
  Deferred body — phases attach to pre-cut seams

  ┌─ BUILT (buffr v1b) ─────────────────────────────────────────────┐
  │  agents schema ──┬─ app_id col ───────────────┐                  │
  │                  ├─ embedding_model col ──────┐│                  │
  │                  └─ conversations/messages ──┐││                  │
  │  VectorStore contract ───────────────────────┼┼┼─┐               │
  │  index/ask/eval CLI · pg direct · 768 dim    │││ │               │
  └──────────────────────────────────────────────┼┼┼─┼──────────────┘
                                                  │││ │ attach (no rework)
  ┌─ DEFERRED (named) ─────────────────────────────▼▼▼─▼─────────────┐
  │  RLS + token app_id  ◄─ app_id col                              │
  │  reindex / embedder swap  ◄─ embedding_model col                │
  │  trajectory → fine-tune  ◄─ messages rows                       │
  │  phone body · edge API · sync  ◄─ VectorStore contract          │
  └──────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** The pattern isn't a function — it's a property of how the
schema and contract were *shaped*. You see it in the columns that exist for
nobody yet, the contract that allows bodies that don't exist yet, and the
captures with no consumer yet.

**Forward-compat columns, one tenant** — `sql/001_agents_schema.sql:6, 16-23`

```
  app_id text not null default 'laptop',        ← every table: documents(6),
                                                   chunks(16), conversations,
                                                   messages, profiles
  embedding_model text not null default 'nomic-embed-text:v1.5',  ← chunks:23
        │
        └─ both columns carry exactly one value today. They exist so RLS
           (app_id) and reindex (embedding_model) attach later with no migration.
```

**app_id sourced from config, ready to become token-derived** —
`src/config.ts:11`

```
  appId: env.AGENT_APP_ID || 'laptop',
        │
        └─ today: env var → config → every query's app_id filter. The deferred
           phase replaces this source with a JWT claim and adds RLS. The
           call sites (pg-vector-store.ts:73 `where app_id = $2`, etc.) don't
           change — only where app_id COMES FROM changes.
```

**The contract that lets the body change** — `src/pg-vector-store.ts:19`

```
  export class PgVectorStore implements VectorStore {
        │
        └─ the agent depends on VectorStore, not on this class. The deferred
           phone/edge bodies implement the same interface — agent untouched.
           This is seam 2, shared with 01-vector-store-adapter.md.
```

**Capture with no consumer yet** — `src/supabase-trace-sink.ts:29-33`

```
  this.pending.push(persistMessage(pool, conversationId, 'assistant', event.content)); ← 30
  ... persistMessage(... 'tool', event.toolName, { toolResults: event.result }));      ← 32-33
        │
        └─ these rows are written every run for history/debugging. The fine-tune
           consumer doesn't exist and may never — but the data must exist NOW
           to ever be usable. Seam 4.
```

**The deferral, stated and gated** — design doc out-of-scope list +
open questions

```
  Out of scope (deferred): Edge Functions / HTTP API · RLS · tool_runs cache ·
  the phone · laptop↔phone sync · multi-platform gateway · fine-tune
  (laptop-supabase-graduation-design.md:184-189)

  Gating: "Adding RLS + always-derive-app_id-from-token is a hard prerequisite
  before a second app writes." (:193)
        │
        └─ the deferral is explicit and gated on a trigger (app #2), not vague.
           That precision is what separates this from "we'll get to it."
```

## Elaborate

This is evolutionary architecture (Ford/Parsons/Kua) crossed with disciplined
YAGNI: don't build speculative behavior, but do protect the *expensive-to-
change* decisions with seams. The reader has shipped both failure modes' cures
across the portfolio — dryrun's GitHub-as-backend deferred a real DB; contrl
deferred all cloud to keep the hot path local; AdvntrCue colocated vector +
relational to defer a separate store. buffr is the most explicit version: the
design doc literally lists what's deferred and the trigger that un-defers each.
The single sharpest call is the RLS deferral — `app_id` isolation is "by
convention only until app #2" (design doc :193), which is honest about a real
risk and gates it precisely rather than pretending the convention is
enforcement. The interview-grade insight: deferral is only credible when you
can name *the trigger that ends it* and *the seam it attaches to*. Vague "we'll
scale later" fails both; buffr passes both.

## Interview defense

**Q: You shipped a single-device app with `app_id` on every table and no RLS.
Isn't that either over-engineering or a security hole?**

Neither — it's a pre-cut seam. `app_id` is a column (cheap now) but RLS is
behavior (deferred), because there's exactly one tenant. The column exists so
that when app #2 arrives, RLS and token-derived `app_id` attach to the
existing schema with no migration. The design names that trigger explicitly:
RLS is a hard prerequisite *before* a second app writes, not before.

```
  app_id column (built, cheap) ──► RLS policy (deferred, attaches here at app #2)
```

Anchor: `sql/001_agents_schema.sql:6`; design doc :193.

**Q: Why capture every conversation if nothing reads them?**

Because the data is impossible to capture retroactively. Fine-tuning is the
deferred, eval-gated ceiling — but the day Phase-4 numbers might justify it,
you need a corpus of trajectories, and you can't go back and record past
conversations. Capture is cheap; the absence of data is fatal. The consumer is
deferred; the capture can't be.

```
  capture now (cheap) ──► fine-tune later (gated on Phase 4 eval) OR never
  defer capture ──► no data the day you need it ──► dead end
```

Anchor: `src/supabase-trace-sink.ts:29-33`; `agent-layer-plan.md` Phase 4.

## Validate

1. **Reconstruct.** From memory, name the four seams that carry the deferral
   and the deferred phase each one un-blocks.
2. **Explain.** Why is `app_id` built now but RLS deferred? What makes that
   asymmetry the right call? (`sql/001_agents_schema.sql:6`; design doc :193.)
3. **Apply.** You're told to add the phone next month. Which built artifacts
   does the phone reuse unchanged, and which seam does its store attach to?
   (`VectorStore` contract; `agents` schema.)
4. **Defend.** Argue that capturing trajectories with no consumer
   (`supabase-trace-sink.ts:29-33`) is not dead code — name what it would cost
   to add this capture *after* deciding to fine-tune.

## See also

- `01-vector-store-adapter.md` — the contract that is seam 2.
- `03-trajectory-capture.md` — the capture that is seam 4.
- `04-library-as-dependency-boundary.md` — why swapping the body leaves the
  toolkit untouched.
- `06-profile-injection-as-context.md` — `app_id` scoping as another forward-
  compat seam.
- `study-distributed-systems` — the coordination the deferred sync/edge phases
  introduce.
- `study-data-modeling` — the forward-compat column shapes in detail.
