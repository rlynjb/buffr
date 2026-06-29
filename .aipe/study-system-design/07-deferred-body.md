# 07 — Deferred Body

**Industry name(s):** Deferred architecture / forward-compatible scaffolding / "decide the
parts, defer the body." Build-order risk sequencing.
**Type:** Project-specific (a deliberate phasing strategy).

## Zoom out, then zoom in

Here's the whole system — and a dotted outline of the system it's *designed to become*.
buffr-laptop is **v1b of a deliberately-deferred body**: a two-brain (laptop + phone)
agent sharing one memory plane. The current repo is the laptop brain only. Everything the
deferred body needs is scaffolded — the contracts, the `app_id` column, the
`embedding_model` column — but nothing distributed is built. The phasing avoids one-way
doors while the decision-independent pieces ship now.

```
  Zoom out — what's built vs what's outlined

  ┌─ BUILT now (this repo, v1b) ────────────────────────────────────────┐
  │  laptop brain: Gemma + pgvector + chat CLI + trajectory capture      │ ← we are here
  │  single device · single writer (app_id='laptop') · direct pg · no RLS │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │ scaffolded seams (contracts, columns)
  ┌─ DEFERRED body (outlined in specs, not built) ──────────────────────┐
  │  ░ phone brain (RN, on-device model)                                 │
  │  ░ laptop↔phone memory sync/merge                                    │
  │  ░ HTTP gateway / Edge Functions                                     │
  │  ░ enforced RLS + always-derive-app_id-from-token                    │
  │  ░ fine-tuning (the ceiling)                                         │
  └───────────────────────────────────────────────────────────────────────┘
```

Zoom in. The pattern is **deferred architecture**: identify the one-way doors, decide
*only* what's irreversible now, scaffold the cheap-now/painful-later seams, and defer the
reversible decisions until evidence forces them. The question it answers: *how do you
build the smallest real thing today without painting yourself into a corner you can't
back out of tomorrow?*

## Structure pass

**Layers:** the decision itself splits into one-way doors (decide now) vs reversible
choices (defer) vs forward-compat scaffolding (cheap insurance).

**Axis — reversibility. Is this decision a one-way door?** Trace it across the choices:
- Embedding dimension (768) → **one-way for data**: re-embedding a corpus is expensive,
  so it's locked now (`agent-layer-plan.md:115`).
- `app_id` / `user_id` / `embedding_model` columns → **cheap now, painful to retrofit**:
  added as forward-compat scaffolding (`...graduation-design.md:29`).
- HTTP API, RLS, phone, sync → **reversible / additive**: deferred, because building them
  now adds indirection for clients that don't exist (`...graduation-design.md:62`).

The axis-answer (one-way vs reversible) is what sorts every decision into "now" or
"later." That sort *is* the strategy.

**Seam:** the contracts — `VectorStore`, `CapabilityTraceSink` — are the seam the deferred
body plugs into. The graduation spec's promise: graduating to any deferred phase "reuses
this schema and the `VectorStore` contract — no rework" (`...graduation-design.md:188`).
The seam is load-bearing precisely because it absorbs the future without changing.

## How it works

### Move 1 — the mental model

You've done this with a feature flag: ship the column and the dormant code path now,
flip it on later when the feature's ready — so the migration isn't a big-bang rewrite.
Deferred architecture is that at the system level: ship the `app_id` column and the
`VectorStore` contract now, plug in RLS and an Edge-Function store later, with no schema
migration and no agent change. The strategy: **pay the cheap forward-compat cost now,
defer the expensive build, lock only what's irreversible.**

```
  the deferral sort — every decision down one of three paths

   decision ──► is it a one-way door?
                  │                    │
                 YES                   NO
                  ▼                    ▼
            decide NOW            is the column/seam cheap now?
        (dimension=768)            │              │
                                  YES             NO
                                   ▼              ▼
                          scaffold NOW       DEFER the build
                       (app_id, model col)  (RLS, phone, sync, gateway)
```

### Move 2.5 — current state vs future state

This is the whole point of the file, so it's a Phase A / Phase B comparison.

```
  Phase A — built now (laptop brain, v1b)     Phase B — deferred body

  reasoning:  Gemma on laptop (local)         + phone on-device model (light brain)
  store:      PgVectorStore (direct pg)        ↳ same VectorStore contract, Edge-Fn adapter
  access:     direct node-postgres             ↳ HTTP gateway wrapping the same SQL
  tenancy:    app_id='laptop', by convention   ↳ enforced RLS, app_id from JWT
  memory:     one store, one device            ↳ TWO brains, one plane = sync/merge problem
  model:      stock Gemma 2                     ↳ fine-tuning (the ceiling, gated on evidence)
  ───────────────────────────────────────     ─────────────────────────────────────────────
  what changes to get to B:  the ADAPTERS and POLICIES around the contracts
  what DOESN'T change:       the contracts, the schema, the agent loop, the chat session
```

**Walk what's scaffolded but dormant:**

- **`app_id` everywhere, RLS nowhere.** Every table carries `app_id` defaulting to
  `'laptop'` (`sql/001_agents_schema.sql:5`, `:17`, `:35`, etc.), and `PgVectorStore`
  scopes every query by it (`src/pg-vector-store.ts:73-76`). But there are **no RLS
  policies** — isolation is by convention. The column is the dormant scaffolding; the
  policy is the deferred flip. The graduation spec names the checkpoint: enforced RLS +
  always-derive-`app_id`-from-token is a hard prerequisite before a second app writes
  (`...graduation-design.md:193`).

- **`embedding_model` column, one embedder.** `chunks.embedding_model` defaults to
  `nomic-embed-text:v1.5` (`sql/001_agents_schema.sql:23`) and is written on every upsert
  (`src/pg-vector-store.ts:55`). Only one embedder runs today; the column exists so a
  future embedder swap (and the first-class reindex it forces) needs no migration — the
  dimension one-way door, named in the column (`...graduation-design.md:130`).

- **The `VectorStore` contract, one adapter.** pgvector is the only store today; the
  Edge-Function-backed store is "a second adapter, deferred to the body decision"
  (`...aptkit-packages-design.md:209`). The contract is the dormant seam.

**Walk what's deferred and why each is reversible:**

- **HTTP gateway / Edge Functions** — deferred because "a single device has one client;
  HTTP API is YAGNI until phone/app #2" (`...graduation-design.md:27`). Adding it later
  wraps the same SQL — additive, no rework.
- **The phone brain + sync** — deferred because two brains, one memory is the
  canonical-local-with-cloud-mirror sync/merge problem, and the build order is
  laptop-first so "the sync problem is the second thing you solve, not the first"
  (`...aptkit-packages-design.md:76`). → coordination mechanics in `study-distributed-systems`.
- **Fine-tuning** — the ceiling, gated on Phase-4 eval evidence, never assumed
  (`agent-layer-plan.md:19`). The trajectory capture (file 03) is what makes it
  *answerable* later — which is exactly why capture ships now even though training is
  deferred.

```
  Layers-and-hops — how the deferred body plugs in (later)

  ┌─ phone brain ─┐   ┌─ laptop brain (TODAY) ─┐
  │ on-device LLM │   │ Gemma + chat CLI       │
  └───────┬───────┘   └───────────┬────────────┘
          │ both reason locally   │
          └───────────┬───────────┘ hop: same VectorStore / CapabilityTraceSink contract
                      ▼
          ┌─ shared plane (Supabase) ─┐
          │ memory + RAG + Edge Fns    │  ░ sync/merge problem appears HERE, only when both live
          └────────────────────────────┘
```

### Move 3 — the principle

The expensive mistake isn't building the small thing — it's building the small thing in a
way that forces a rewrite to grow it. Sort decisions by reversibility: lock the one-way
doors (embedding dimension), scaffold the cheap-now/painful-later seams (`app_id`,
`embedding_model`, the contracts), and defer everything additive (gateway, RLS, phone,
sync, fine-tuning) until evidence demands it. The contract is the insurance policy; the
forward-compat columns are the cheap premium. What you've actually built is a system whose
*growth path requires no rework* — and the proof is that every deferred phase plugs into
seams that already exist.

## Primary diagram

The full deferred-body picture: built core, dormant scaffolding, deferred phases, the
seams that connect them.

```
  deferred body — built core + dormant seams + deferred phases

  ┌─ BUILT: laptop brain (v1b) ─────────────────────────────────────────┐
  │  Gemma · PgVectorStore · chat session · trajectory capture           │
  │  ──────────── dormant scaffolding (cheap now) ────────────           │
  │  app_id col (no RLS) · embedding_model col · VectorStore contract     │
  └───────────────────────────────┬──────────────────────────────────────┘
            plug-in seams (no rework, per ...graduation-design.md:188)
  ┌─ DEFERRED phases (reversible / additive) ─────────────────────────────┐
  │  Edge-Fn store adapter  ·  enforced RLS + app_id-from-JWT             │
  │  phone brain (RN)  ·  laptop↔phone memory sync  ·  fine-tuning        │
  └───────────────────────────────────────────────────────────────────────┘
   LOCKED one-way door (decided now):  embedding dimension = 768
```

## Elaborate

This is "decide the parts, defer the body" from `...aptkit-packages-design.md:21` —
build the buildable, decision-independent pieces now, dodge the one-way doors (sync
model, gateway, two-brain topology) until forced. It's the same instinct as YAGNI plus
the discipline of distinguishing reversible from irreversible decisions (Bezos's one-way
/ two-way doors). The phasing is risk-sequenced: de-risk the hardest piece first (Gemma
tool-calling in aptkit), then persistence (this repo), then the body. It pairs with file
02 — the dependency boundary is *why* deferral costs nothing: new phases inject new
adapters into unchanged contracts. The distributed-correctness of the eventual two-brain
sync belongs to `study-distributed-systems`; this file owns the architectural *decision*
to defer it and the scaffolding that makes the deferral safe.

What to read next: `02-library-as-dependency-boundary.md` (the seams the body plugs
into), `03-trajectory-capture.md` (why capture ships before fine-tuning), `audit.md`
lens 7 (what breaks first at scale).

## Interview defense

**Q: Why ship a single-device laptop brain when the goal is a two-brain body?**
Because the body has one-way doors (sync model, gateway topology) that shouldn't be
decided without building the parts first. Laptop-first means the sync/merge problem — the
hardest part — is the *second* thing you solve, not the first. The buildable,
decision-independent pieces ship now; the irreversible ones wait for evidence.

```
  build order:  laptop brain ──► phone brain ──► sync (the hard part, last)
```
Anchor: build-order rationale at `...aptkit-packages-design.md:76`;
"decide the parts, defer the body" at `:21`.

**Q: What did you lock now, and what did you defer?**
Locked the one-way door: embedding dimension 768 (re-embedding a corpus is expensive).
Scaffolded the cheap-now seams: `app_id`, `embedding_model`, the `VectorStore` contract.
Deferred the additive/reversible: HTTP gateway, RLS, phone, sync, fine-tuning — each
plugs into existing seams with no rework.
Anchor: dimension lock at `agent-layer-plan.md:115`; forward-compat columns at
`...graduation-design.md:29`; "no rework" promise at `:188`.

**Q: What proves the deferral is safe and not just procrastination?**
Every deferred phase has a named seam it plugs into. Edge-Fn store → the `VectorStore`
contract. RLS → the `app_id` column already on every table. Fine-tuning → the trajectory
already captured. The scaffolding is built; only the policies and adapters are deferred.
Anchor: the contracts at `src/pg-vector-store.ts:19`, `src/supabase-trace-sink.ts:49`;
`app_id` columns across `sql/001_agents_schema.sql`.

## See also

- `02-library-as-dependency-boundary.md` — the contracts the deferred body plugs into
- `03-trajectory-capture.md` — capture ships now so fine-tuning is answerable later
- `audit.md` — lens 7 (scale bottlenecks) and lens 8 (the RLS-by-convention risk)
- `study-distributed-systems` — the two-brain sync/merge correctness, when it lands
