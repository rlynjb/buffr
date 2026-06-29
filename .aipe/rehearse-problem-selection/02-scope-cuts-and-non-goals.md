# 02 — Scope, Cuts, and Non-Goals

The discipline that separates a staff engineer from someone with a feature wishlist: naming
the **smallest slice that validates the premise** and then naming, out loud and without
apology, everything you deliberately did *not* build. Every cut here is a recorded decision,
not an accident — which is the whole point. A reviewer trusts a scope you can defend the
edges of.

## Zoom out — scope as a series of doors

Think of the full vision (the two-brain laptop+phone body, multi-app HTTP API, RLS,
fine-tuning) as a corridor of doors. Some swing both ways; some lock behind you. The shipped
scope walks through exactly the doors that are cheap to reverse and **stops at the one-way
doors on purpose**.

```
  Scope = walk the reversible doors, stop at the one-way ones

  ┌─ SHIPPED (v1b — smallest persistent slice) ───────────────────────┐
  │  one agent · one device · one user (app_id='laptop')              │
  │  direct pg · Supabase pgvector + HNSW · trajectory capture        │
  │  Ink chat TUI · profile injection · episodic memory               │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  every door below is DEFERRED,
                                  │  named in the design specs, reachable
                                  │  without rework (same schema, same port)
        ┌──────────────┬──────────┴───────┬──────────────┬─────────────┐
        ▼              ▼                  ▼              ▼             ▼
   ✗ the phone    ✗ HTTP/Edge       ✗ RLS +        ✗ a platform   ✗ fine-tuning
   (two-brain     Function API      multi-tenant   of N agents    (LoRA/QLoRA
   body)          layer             isolation                     on Gemma)
   ONE-WAY-ISH    YAGNI until       hard prereq    "ship ONE,     the CEILING,
   — deferred to  app #2 / phone    before app #2  measure it"    only on Phase-4
   dodge the door                   writes                        evidence
```

## The smallest useful scope — what validates the premise

The premise to validate: *can one off-the-shelf-Gemma RAG agent, on a real persistent store,
answer from your context well enough to be worth it — and can you measure that?* The smallest
slice that answers that question, and nothing more:

```
  The validating slice — every piece earns its place by testing the premise

  index a real markdown corpus  ──► proves the index path works on real data
         │                            (chunk → embed 768d → upsert pgvector)
         ▼
  ask, get a cited answer       ──► proves the query path: embed → HNSW ANN
         │                            → ground → Gemma answers from retrieval
         ▼
  persist the conversation      ──► proves trajectory capture (the Hermes idea
         │                            worth stealing) — fine-tuning stays
         │                            ANSWERABLE later, not assumed now
         ▼
  eval: precision@k on a        ──► proves you can MEASURE it — the line
  labeled set                        between "played with an LLM" and "does
                                      AI engineering" (→ 04)
```

If any one of these were missing, the premise wouldn't be validated. There's nothing in the
slice that *isn't* load-bearing for the question — that's the test for "smallest useful."

**Strong answer, your voice:**
> "The smallest slice that actually tests the idea is: index a real corpus, ask and get a
> cited answer, persist the full trajectory, and score precision@k on a labeled set. Four
> things. Each one proves a different part of the premise — the index path, the query path,
> that I'm capturing data for a later fine-tune decision, and that I can *measure* quality.
> Drop any one and I can't tell whether it worked. Everything past those four — the phone,
> the HTTP API, RLS, fine-tuning — is deferred behind a door I can reach without rework."

## The cuts — named, with the reason each was cut

This is the heart of the file. Each cut is a documented decision. The phrasing in the room
matters: *not* "I didn't get to X" but "I cut X because Y, and here's how I made sure cutting
it costs nothing later."

### Cut 1 — the phone (the two-brain body)

```
  Why the phone is deferred — it's a one-way door, and you dodge it

  the full vision:  laptop brain  ◄──sync──►  phone brain
                    (this exists)             (deferred)
                         │
  the trap:  laptop↔phone sync forces irreversible choices NOW —
             conflict resolution, on-device model, sync protocol —
             before you've proven the SINGLE brain is even good.
             So: build one brain, measure it, THEN decide the body.
```

This is the cleanest "I avoid one-way doors" story you have. The two-brain body is the
original vision, and you *deferred it on purpose* to avoid locking in sync decisions before
the single agent is proven. That's senior judgment, and it's documented in
`agent-layer-plan.md` ("deferred the two-brain laptop+phone body").

### Cut 2 — the HTTP / Edge Function API

```
  Direct pg now, HTTP later — YAGNI with a named return path

  SHIPPED:   buffr runtime  ──node-postgres (direct TCP)──►  Postgres
  DEFERRED:  buffr runtime  ──HTTPS──► Edge Functions ──► same SQL

  one client exists. PostgREST indirection + latency for an audience
  of one is cost with no buyer. The HTTP layer wraps the SAME SQL when
  app #2 or the phone arrives — it's additive, not a rewrite.
```

### Cut 3 — RLS and multi-tenant isolation

```
  No RLS this phase — but the column is already there

  every agents.* table carries app_id (default 'laptop') NOW.
  RLS policies (USING app_id = jwt.claim.app_id) are NOT written yet.

  why cheap-now / painful-later: adding the COLUMN later = a migration
  over a live corpus. Adding the POLICY later = a few lines. So you pay
  the cheap forward-compat cost now, defer the policy until app #2.
  Hard prerequisite: RLS + always-derive-app_id-from-token MUST land
  before a second tenant writes. Named, not forgotten.
```

This is the sharpest forward-compat call in the whole project: **the schema is shaped for
multi-tenant from day one (the `app_id` column), but the enforcement (RLS) is deferred.** You
pay the cheap structural cost now to avoid the expensive migration later, and you defer the
part that's genuinely cheap to add later. That's exactly the right place to draw the line.

### Cut 4 — a platform of many agents

```
  ONE agent, end-to-end, measured — not a fleet

  ✗ N agents, sub-agent orchestration, skill auto-generation (that's Hermes)
  ✓ one RAG agent, shipped, with eval numbers

  "Don't ship a platform before one good agent works end-to-end."
  aptkit's 5 packaged agents are TEMPLATES, not the product. Generalizing
  to a fleet is a decision made FROM Phase-4 evidence, not toward it.
```

### Cut 5 — fine-tuning

```
  Fine-tuning is the CEILING, gated on evidence

  trajectory capture (now)  ──► makes fine-tuning ANSWERABLE later
  fine-tuning (LoRA/QLoRA)  ──► only if Phase-4 failures are model-bound
                                AND narrow AND the captured trajectories
                                can supply the data. Never pre-train.
```

The elegant part: cut 5 and the smallest-slice item "persist the trajectory" are the same
decision seen from two angles. You capture trajectories *now* precisely so that the deferred
fine-tuning decision is **answerable from data** instead of assumed. The cut and the
capture-discipline are one move.

## Non-goals — what this is explicitly NOT

```
  NON-GOAL                          BECAUSE
  ──────────────────────────────    ─────────────────────────────────────────
  a product with paying users       there's one user; inventing a market is
                                    a lie that collapses on the first question
  a Hermes clone                    steal the trajectory-capture DISCIPLINE,
                                    none of the platform machinery or fine-tunes
  centralizing the DATA             centralize the agent LAYER; apps keep their
                                    schemas and opt into agents.documents
  reinventing the agent loop /      use aptkit + pgvector; build the GLUE and the
  vector search                     JUDGMENT layer — that's where the signal is
  horizontal scale / queues /       single device, one user — not the problem
  load balancing                    being solved, and faking the need would show
```

## Primary diagram — scope on one page

The shipped slice in the center, every cut radiating out with its reason and its return path.

```
  SCOPE — shipped core + deferred doors, one frame

                        ┌─────────────────────────────┐
                        │   SHIPPED: one agent · one   │
                        │   device · one user · pg +   │
                        │   pgvector · trajectory cap  │
                        │   · Ink TUI · precision@k    │
                        └──────────────┬──────────────┘
        deferred,                      │                    deferred,
        reachable                      │                    reachable
   ┌────────────┬───────────┬──────────┴────┬───────────┬────────────┐
   ▼            ▼           ▼               ▼           ▼            ▼
 phone        HTTP/       RLS +          platform     fine-tune   cross-app
 (one-way     Edge Fn     multi-tenant   of N agents  (ceiling,   retrieval
 door,        (YAGNI,     (column now,   (measure     evidence-   (explicit
 dodged)      same SQL)   policy later)  ONE first)   gated)      policy later)

  every door: named in a design spec · same schema · same VectorStore port · no rework
```

## The principle

Scope discipline isn't about doing less — it's about cutting along the **reversibility line**.
Pay the cheap irreversible costs now (the `app_id` column, the 768-dim choice), defer the
expensive-but-reversible work (RLS policy, HTTP wrapper, the phone), and refuse the work that
doesn't serve the premise at all (a platform, a market, horizontal scale). A cut you can
defend the edge of — *why here and not one feature further* — is worth more than a feature you
shipped without a reason.

## See also

- `01-problem-brief.md` — the problem this minimal slice validates
- `03-options-and-opportunity-cost.md` — why build the slice at all vs buy Hermes
- `04-success-metrics-and-feedback-loop.md` — the eval that closes the smallest slice
- `docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md` — the locked decisions + "Out of scope" + "As-built deviations"
- `agent-layer-plan.md` — "What NOT to do" and "Open questions (one-way doors)"
