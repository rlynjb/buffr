# Deferred: Two-Brain Shared Memory — **DESIGN, NOT CODE**

> **Read this banner first.** Nothing in this file exists in the repo. Zero lines of code implement it. It describes a *future* phase captured in `docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md` and `agent-layer-plan.md`, both explicitly marked **deferred**. Every diagram below is the **planned** shape, labeled as such. This file exists because the deferred phase is the *only* genuine distributed-systems problem in this project's future, and naming the problem now — before it's built — is the honest thing to do. Where today's code touches the future plan, that's flagged inline.

**Industry names:** multi-writer shared store · centralized agent layer · tenant isolation via token claims · cross-device memory sync. **Type:** Industry standard (the *plan*; not yet a project pattern).

## Zoom out, then zoom in

Today `buffr-laptop` has one writer. The deferred design adds a **second brain** — a phone (React Native, on-device model) — that writes the *same* `agents.*` tables through the *same* Supabase, behind an HTTP gateway. The instant that second writer lands, this stops being a single-device program and becomes a real distributed system: shared mutable state, two clocks, isolation-by-token, ordering under partition. Here's where the future seam sits relative to today.

```
  Zoom out — the DEFERRED two-brain shape (NOT BUILT)

  ┌─ Client layer ───────────────────────────────────────────────┐
  │  laptop brain (EXISTS today)      phone brain (DEFERRED)       │
  │  app_id='laptop'                  app_id='phone' (planned)     │
  └─────────┬───────────────────────────────────┬─────────────────┘
            │ today: direct pg                    │ planned: HTTPS + JWT
            │                                     │
            │            ┌─ ★ DEFERRED gateway ★ ─┘  ← THIS FILE (design only)
            │            │  Edge Functions, app_id from JWT claim, RLS
            ▼            ▼
  ┌─ Storage layer (shared, multi-writer in the plan) ───────────┐
  │  reindb · agents schema                                       │
  │  documents · chunks · conversations · messages · profiles     │
  │  TWO writers in Phase B → consistency, ordering, isolation    │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is a **centralized agent layer with multiple tenant writers, isolated by a token claim, coordinating over one shared Postgres.** The distributed-systems question it raises — the one today's repo never has to answer — is *"when two brains write and read the same store, what stays correct under skew, staleness, and partition?"* The plan answers some of it (isolation via JWT-derived `app_id` + RLS) and explicitly leaves the rest open (cross-device ordering, conflict on shared memory).

## The structure pass

**Layers (planned).** Three: two client brains (laptop today, phone deferred), an HTTP gateway (Edge Functions, deferred), one shared Postgres. The gateway is the new joint that doesn't exist yet.

**The axis: trust / isolation — what can each writer see or tamper with?** This is the axis the plan is most explicit about, so trace it.

```
  One axis — "what can each writer touch?" — across the DEFERRED gateway

  ┌─ today (1 writer) ─┐                  ┌─ planned (N writers) ─────────┐
  │ laptop writes      │   gateway seam   │ each app: JWT carries app_id  │
  │ app_id='laptop'    │ ═════╪═════════► │ RLS: USING (app_id =          │
  │ direct pg, no RLS  │  (trust flips)   │   jwt.claim.app_id)           │
  │ isolation: NONE    │                  │ app_id NEVER from request body│
  │ (1 tenant, fine)   │                  │ isolation: enforced by DB     │
  └────────────────────┘                  └───────────────────────────────┘
```

**The gateway is the load-bearing future seam because trust flips across it.** Today there's no trust boundary — one writer, `app_id` hardcoded `'laptop'`, no RLS (the design says so outright: "No RLS this phase"). In the plan, the gateway is where `app_id` stops being a trusted constant and becomes a *claim derived from a token*, with RLS as defense-in-depth. That flip — from "trusted single writer" to "untrusted multi-tenant, isolation enforced by the database" — is the entire reason the deferred phase is hard. The open question the design flags: until app #2 writes, "that isolation is by convention only" (`...graduation-design.md`, Open questions).

## How it works (the PLANNED mechanism)

### Move 1 — the mental model

You know the shape from any multi-tenant SaaS backend: many clients, one database, and the thing standing between them is "which rows are *yours*." Today buffr skips that entirely because there's one tenant. The plan reintroduces it the standard way — a token per client carrying a tenant id, and a row-level rule that filters every query to that id. The new distributed wrinkle on top: the two tenants here aren't just isolated, they may want to **share** memory (laptop learns something, phone should recall it), which means reads must converge across writers.

```
  The PLANNED pattern — multi-writer, isolated, partly-shared

   laptop ──┐  JWT{app_id:laptop}    ┌── RLS filters to app_id
            ▼                        ▼
        ┌─ gateway ─┐  ──►  ┌─ agents.* ─┐
            ▲                        ▲
   phone ──┘  JWT{app_id:phone}     └── shared memory: cross-app read = explicit policy
            (DEFERRED)                   (default in plan: NO cross-app, strict isolation)
```

Name the load-bearing parts by what breaks without each (in the *plan*):
- **JWT-derived `app_id`** — without it, a client could write another tenant's rows by lying in the body. The plan's rule: "`app_id` is **always** derived from the token, never the request body."
- **RLS on every `agents.*` table** — without it, isolation is convention only; one bug leaks tenants.
- **A cross-device ordering key that isn't wall-clock** — without it, the two brains' writes to a shared conversation interleave wrong under clock skew (the gap inherited from `02`).

### Move 2 — how today's code already half-prepares for this

The honest, repo-grounded part: **the current code is built to make this future cheap, and you can see the seams already cut.** Three concrete touchpoints where today's single-device code is shaped by the deferred multi-writer plan:

**1. `app_id` exists on every write, hardcoded to one value.** `startConversation` and `persistMessage` already thread `appId` through (`src/supabase-trace-sink.ts:4`, and `session.ts:55` passes `cfg.appId`):

```ts
// src/supabase-trace-sink.ts:4 — appId already a parameter, today always 'laptop'
export async function startConversation(pool, appId, agentName = 'rag-query-agent') {
  await pool.query(
    'insert into agents.conversations (app_id, agent_name) values ($1, $2) returning id',
    [appId, agentName]);   // ← app_id is data today; becomes a JWT claim in the plan
}
```

The column is populated now so adding a second app "needs no migration" (`...graduation-design.md`). What's *missing* for the distributed version: `app_id` here comes from config (`cfg.appId`), trusted. In Phase B it must come from a verified token. Today's `appId` parameter is the seam where that swap happens — the shape is right, the trust source is not yet.

**2. The dropped FK that makes shared memory possible.** `agents.chunks.document_id` has **no foreign key** (`context.md`, "As-built deviations"). That was done for VectorStore drop-in parity — but it's also exactly what lets conversation memory ride the `chunks` table with no `documents` row (`session.ts:53` comment: "memory chunks live with no documents row, which the dropped FK allows"). In the two-brain plan, *shared* memory across devices rides this same mechanism. The decision that looked like a local convenience is load-bearing for the future shared-memory store.

**3. `created_at` from emit timestamp — the single-clock assumption, written down.** Covered in depth in `02-trace-sink-write-buffering.md`. Restated here because it's *the* distributed correctness gap this phase activates: today one clock makes `created_at`-ordering sound; the phone brain is the second clock that breaks it.

```
  Layers-and-hops — TODAY vs the PLANNED two-writer flow

  TODAY (built):                          PLANNED (deferred, NOT built):
  ┌─ laptop ─┐                            ┌─ laptop ─┐   ┌─ phone ─┐
  │ cfg.appId│                            │ JWT      │   │ JWT     │
  └────┬─────┘                            └────┬─────┘   └────┬────┘
       │ pg.Pool (trusted)                     │ HTTPS       │ HTTPS
       ▼                                       ▼             ▼
  ┌─ agents.* ┐                           ┌─ gateway (RLS, app_id from JWT) ┐
  │ 1 writer  │                           └──────────────┬──────────────────┘
  └───────────┘                                          ▼
                                                  ┌─ agents.* (2 writers) ┐
                                                  │ shared, 2 clocks      │
                                                  └───────────────────────┘
```

### Move 2.5 — current state vs future state

This whole file *is* a current-vs-future treatment, so here's the consolidated ledger of what changes and — more usefully — what doesn't.

```
  Phase A (BUILT, today)          Phase B (DEFERRED, this file)        Has to change?
  ──────────────────────          ─────────────────────────────        ──────────────
  1 writer (app_id='laptop')      N writers (laptop, phone, ...)        yes — add writers
  app_id from cfg (trusted)       app_id from JWT claim                 yes — trust source
  no RLS                          RLS on every agents.* table            yes — add policies
  direct pg.Pool                  HTTP gateway (Edge Functions)          yes — new layer
  created_at = wall clock         logical/server sequence for ordering   yes — ordering key
  ── what stays ──
  agents schema + columns          same schema (app_id/user_id ready)    NO
  PgVectorStore / VectorStore      same contract                         NO
  trajectory capture (sink)        same sink, same events                NO
  dropped-FK shared-memory store   same mechanism, now cross-device      NO
```

The payoff is the right-hand column: the **schema, the store contract, the capture discipline, and the shared-memory mechanism all survive untouched.** The design built them forward-compatible on purpose ("forward-compat columns, no RLS"). What genuinely has to be built new is the gateway, the RLS, the token-derived `app_id`, and a skew-proof ordering key. That's the real distributed-systems work, and it's all still open.

### Move 3 — the principle

The cheapest time to make a system distribute-able is *before* it distributes — by writing the tenant key, the store contract, and the capture discipline forward-compatible while there's still one writer to keep it simple. The principle: **a single-device system that names its future distribution seams (the `app_id` column, the trust-source swap, the clock assumption) pays almost nothing now and avoids a rewrite later — but only if it's honest that those seams are unguarded today.** The danger is the opposite: a single-writer system that *pretends* its `app_id` column is isolation. It isn't, until RLS and JWT-derived claims exist. This file's job is to keep that distinction sharp.

## Primary diagram

The deferred two-brain system, full planned shape, with today's reality marked.

```
  Two-brain shared memory — DEFERRED design (full recap)

  ┌─ Client layer ───────────────────────────────────────────────────┐
  │  laptop brain (BUILT)            phone brain (DEFERRED, RN)        │
  │  app_id from cfg                 app_id from JWT claim             │
  └────────┬──────────────────────────────────┬──────────────────────┘
           │ today: direct pg                  │ planned: HTTPS + JWT
           │                                   ▼
           │                  ┌─ Gateway layer (DEFERRED) ────────────┐
           │                  │ Edge Functions: /search /documents    │
           │                  │ /conversations /messages              │
           │                  │ app_id ALWAYS from token, never body  │
           │                  └──────────────────┬────────────────────┘
           ▼                                     ▼
  ┌─ Storage layer (shared) ─────────────────────────────────────────┐
  │  reindb · agents schema (pgvector + HNSW)                         │
  │  • app_id column on every table (BUILT, 1 value today)           │
  │  • RLS policies (DEFERRED — "no RLS this phase")                 │
  │  • dropped chunks.document_id FK → shared memory store (BUILT)   │
  │  • created_at ordering: 1 clock today → needs logical clock w/ 2 │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

The centralized-agent-layer idea is lifted, explicitly, from Hermes Agent's trajectory-capture discipline minus its platform machinery (`agent-layer-plan.md`: "borrowing Hermes Agent's trajectory-capture discipline but none of its platform"). The systems-design substance — centralize the *agent layer*, not the *data*; existing per-app schemas stay put; apps consume over HTTP only — is `study-system-design`'s to teach (`study-system-design/07-deferred-body.md` walks the deferral decision). This file's narrow job is the **distributed-correctness** slice: what breaks when the second writer arrives.

The two open questions the design itself flags are both distributed-systems questions: (1) the **RLS-later checkpoint** — "isolation is by convention only until app #2," and adding RLS + always-derive-`app_id`-from-token is "a hard prerequisite before a second app writes"; (2) cross-app retrieval defaulting to strict isolation, with sharing as "an explicit policy decision." Both are correctly deferred — building them now would be infrastructure for tenants that don't exist. But both are one-way doors, which is why the columns and the contract were laid down forward-compatible.

The clock question (`02`'s Phase B) is the one the design *doesn't* explicitly flag and this guide adds: cross-device `created_at` ordering needs a logical clock. Flagging it now, while it's free, is exactly the move this whole project is built around.

## Interview defense

**Q: "Today this is one device. What actually changes when you add the phone brain — what's the hard part?"**

> Three things flip, and one trap to avoid. The flips: `app_id` goes from a trusted config value to a JWT-derived claim; you add RLS on every `agents.*` table (there's none today, by design); and you front it with an HTTP gateway instead of direct `pg`. The trap: the trajectory ordering. Today `created_at` comes from `event.timestamp` on one clock, so replay order is sound. With a second writer you have two clocks — wall-clock ordering silently interleaves wrong on skew. So the hard part isn't the gateway plumbing, it's that I now need a logical clock or a server-assigned sequence for ordering, not `now()`.

```
  flips:  app_id cfg→JWT  ·  no-RLS→RLS  ·  direct-pg→gateway
  trap:   created_at (1 clock, sound) ──► 2 clocks ──► needs logical clock
  free:   schema, VectorStore contract, trace sink, shared-memory store  (all survive)
```

> The thing I'd lead with: most of the schema and contracts survive untouched — the `app_id` column, the store contract, the capture discipline were all built forward-compatible while there was one writer. The new work is small and well-scoped. What I would *not* claim is that today's `app_id` column gives isolation — it doesn't, until RLS and token-derived claims exist. It's convention only right now, and the design says so.

**Anchor:** *"app_id→JWT, add RLS, add a gateway — but the real distributed gotcha is the single-clock created_at ordering breaking on a second writer."*

## See also

- `02-trace-sink-write-buffering.md` — the single-clock ordering this phase breaks (Phase B).
- `01-app-to-postgres-boundary.md` — the direct-pg seam the gateway would replace.
- `audit.md` — lenses 4 (consistency), 7 (clocks), 8 (sagas/outbox); all `not yet exercised` and all activated by this phase.
- `study-system-design/07-deferred-body.md` — the deferral decision from the architecture side.
- `study-database-systems/08-replication-and-read-consistency.md` — datastore-local consistency the shared store would lean on.
