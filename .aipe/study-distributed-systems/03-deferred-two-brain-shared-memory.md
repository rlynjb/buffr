# 03 — Deferred: two-brain shared memory  ⚠ DESIGN-NOT-CODE

> **This file describes design, not code.** Nothing in here is implemented.
> The source is two design documents — `agent-layer-plan.md` and
> `docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md`
> (status: *"Design — approved to capture, implementation not started"*). It is
> in this guide because it's where the `not yet exercised` lenses *become*
> exercised, and because two of today's design choices (the physical-clock sort
> key, the convention-only `app_id` isolation) are load-bearing prerequisites
> that have to be retired *before* this ships. Read it as a forward-looking RFC
> seed, not a description of the repo.

## Subtitle

**Multi-writer shared storage** with **convention-vs-enforced tenant
isolation** and **cross-device event ordering** — *Industry standard* problems,
*deferred design*. The local name for the future shape: laptop + phone sharing
one `agents` schema in Supabase.

## Zoom out, then zoom in

Today there is one writer. The parent vision is several: laptop, phone, and
other apps (`buffr`, `blooming`, `contrl`) all writing into one centralized
`agents` schema, reached over an HTTP/Edge-Function gateway with RLS
(`agent-layer-plan.md` architecture, lines 59-86).

```
  Zoom out — the deferred topology (DESIGN-NOT-CODE)

  ┌─ Clients (MANY — future) ──────────────────────────────────┐
  │   laptop brain        phone brain        other apps         │
  │   (this repo, today)  (RN, deferred)     (deferred)         │
  └───────┬───────────────────┬──────────────────┬─────────────┘
          │  HTTPS (app_id in JWT) — deferred gateway            │
          ▼                   ▼                  ▼
  ┌─ Service: Supabase Edge Functions (deferred) ──────────────┐
  │   /search /documents /conversations /messages              │
  └───────────────────────────┬────────────────────────────────┘
                              │
  ┌─ Storage: one Postgres / agents schema ──▼─────────────────┐
  │   shared across ALL writers, keyed by app_id               │
  │   ★ this is where the coordination problems wake up ★       │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the moment storage is shared by more than one writer, three
distributed-systems lenses that are `not yet exercised` today all activate at
once — **multi-writer consistency**, **enforced tenant isolation**, and
**cross-device event ordering**. This file walks each as a *prerequisite to
solve*, with the today-code that has to change.

## Structure pass — what flips when the writer count goes from 1 to N

One axis — **"how many writers touch `agents.*`?"** — and every guarantee that
rides on the answer being "one."

```
  axis = "how many writers?"   1 (today)  →  N (deferred)

  ┌─ ordering ────────────────┐   1: physical clock IS a total order
  │ created_at = event.ts     │   N: two clocks → ORDER BY created_at can lie
  └───────────────────────────┘      → needs a LOGICAL clock

  ┌─ isolation ───────────────┐   1: app_id='laptop' by convention, fine
  │ app_id tag, no RLS        │   N: convention ≠ boundary
  └───────────────────────────┘      → needs RLS, app_id from JWT not body

  ┌─ consistency ─────────────┐   1: single writer, read-your-writes free
  │ same process reads+writes │   N: stale reads, write conflicts appear
  └───────────────────────────┘      → needs a conflict/merge story

  the boundary "1 → N writers" is where all three flip. it does not
  exist in code today; it's the first thing the deferred phase crosses.
```

## How it works (the design, walked as future-state)

### Move 1 — the mental model

You already shipped this shape's *opposite*. buffr today is the single-writer
case: one process, one clock, one tenant, and every distributed-systems
guarantee falls out for free. The deferred design removes the "one" from each of
those, and each removal is a known problem with a known fix. The mental model is
just: **count the writers, then check every guarantee that assumed the count was
one.**

```
  the prerequisite kernel — three guarantees that assumed "1 writer"

   guarantee            holds because (today)      breaks when (N writers)
   ─────────            ──────────────────────     ──────────────────────
   ordering        ◄── one clock stamps all    ── two clocks disagree
   isolation       ◄── one tenant, convention  ── a second tenant writes
   read-your-write ◄── one reader = the writer ── a remote writer raced you
```

### Move 2 — the three prerequisites

**Prerequisite 1 — a logical clock (today's physical one breaks).** This is
the direct continuation of `02`. Today `created_at = event.timestamp`
(`src/supabase-trace-sink.ts:54`, `src/session.ts:30`) is a valid total order
because one machine stamps everything. Two devices stamping from two clocks can
disagree by seconds, so `ORDER BY created_at` can interleave events wrong.

```
  Comparison — ordering under 1 vs N clocks

  Phase A (code today)              Phase B (deferred)
  ──────────────────────            ──────────────────────
  laptop clock ─► created_at        laptop clock ─► created_at
                                    phone  clock ─► created_at
  one clock = total order           two clocks = partial order at best
  ORDER BY created_at ✓             ORDER BY created_at can lie ✗
                                    → per-conversation sequence number,
                                      or server-assigned monotonic id
```

The fix is a **logical clock** — a monotonic sequence per conversation, or a
server-assigned ordering id at insert — so order never depends on two machines
agreeing on wall-clock time. The today-code that changes: the
`created_at`-as-sort-key contract in `persistMessage` and the
`event.timestamp` capture in the sink. Everything else (the buffer, the
per-event persistence) stays.

**Prerequisite 2 — RLS turns convention into a boundary.** Today every row
carries `app_id` (default `'laptop'`, `context.md`), but isolation is **by
convention only — no RLS this phase** (`context.md`; design open-questions lines
191-195). With one writer, `app_id` is a label nobody can violate because nobody
else writes. With a second writer reachable over HTTP, `app_id` has to become an
*enforced* boundary:

```
  Layers-and-hops — app_id must come from the token, not the body

  ┌─ Client (phone) ─┐  hop 1: POST /messages   ┌─ Edge Fn (deferred) ─┐
  │  JWT{app_id:buffr}│ ───────────────────────► │ derive app_id from   │
  │  body{app_id:???} │   (body app_id IGNORED)   │ JWT claim, NOT body  │
  └──────────────────┘                           └──────────┬───────────┘
                                                  hop 2: SQL  │ with RLS
                                                              ▼
                                            ┌─ Postgres agents.* ──────┐
                                            │ RLS: USING (app_id =      │
                                            │   jwt.claim.app_id)       │
                                            └───────────────────────────┘
```

The design states this as a hard prerequisite: RLS + always-derive-`app_id`-
from-token is required *before* a second app writes (design lines 191-195;
`agent-layer-plan.md` line 85, "Don't trust `app_id` from clients"). The
today-gap: there is no RLS and no JWT — `app_id` arrives as a plain function
argument (`startConversation(pool, appId)`, `src/session.ts:55`). That's safe
with one writer and a trust boundary the day there are two.

**Prerequisite 3 — multi-writer consistency and memory sync.** Today
read-your-writes is free: the same process that wrote `chunks` (memory) reads
them next turn (`src/session.ts:53,66`). With laptop and phone both writing
memory into the shared store, a turn on the phone might not yet see memory the
laptop wrote a second ago (replication/visibility lag over the network), and two
devices could write conflicting profile updates. The design names "laptop↔phone
memory sync" explicitly as deferred (design out-of-scope, lines 184-189;
`agent-layer-plan.md` "single agent" framing). No conflict-resolution or merge
strategy is designed yet — which is correct, because the writers don't exist
yet.

### Move 2.5 — what does NOT have to change (the payoff)

The reassuring half. The design was built forward-compatible *on purpose* so
this transition is additive, not a rewrite:

- The schema already carries `app_id`, `user_id`, `embedding_model` as
  forward-compat columns precisely so adding apps needs no migration (design
  lines 27-33, 127-130).
- `PgVectorStore` implements aptkit's `VectorStore` contract, so swapping the
  direct-`pg` path for an HTTP/Edge-Function path is behind a seam the agent
  never sees (design lines 49-52, 184-189).
- The deferred HTTP gateway "wraps the same SQL" — the queries don't change,
  the access path does (design lines 62-64).

So the load-bearing changes are narrow: **a logical clock**, **RLS + JWT-derived
`app_id`**, and **a memory-sync/conflict story.** Three named problems, not a
re-architecture.

### Move 3 — the principle

**Single-writer is a special case where the hard distributed-systems guarantees
are free — and the discipline is to know exactly which "free" guarantees you're
spending the day you add the second writer.** buffr's two design docs do this
well: they don't build the multi-writer machinery early (YAGNI — there's one
device), but they *name the prerequisites* (RLS-later checkpoint, the clock
question is implicit in the timestamp choice) so the bill is visible before it's
due. Naming the deferred cost without paying it early is the judgment, not a gap.

## Primary diagram

The deferred topology with the three prerequisites marked at the boundary they
guard.

```
  Two-brain shared memory — the prerequisites (DESIGN-NOT-CODE)

  ┌─ Clients (N — deferred) ───────────────────────────────────┐
  │  laptop (today)            phone (deferred)                 │
  └──────┬──────────────────────────┬──────────────────────────┘
         │  HTTPS, app_id in JWT     │   ⓶ RLS + JWT-derived app_id
         ▼                           ▼      (today: plain arg, no RLS)
  ┌─ Service: Edge Functions (deferred) ───────────────────────┐
  │   same SQL, new access path                                │
  └──────────────────────────┬──────────────────────────────────┘
                             │
  ┌─ Storage: shared agents schema ──▼─────────────────────────┐
  │  messages.created_at  ── ⓵ needs a LOGICAL clock           │
  │                            (today: physical event.timestamp)│
  │  chunks (memory)      ── ⓷ needs sync/conflict story        │
  │                            (today: single-writer, free)     │
  └─────────────────────────────────────────────────────────────┘

  ⓵⓶⓷ all dormant today; all wake at the 1→N writer boundary.
```

## Elaborate

This is the classic "scale-up by adding a node" inflection that every
single-node system eventually faces: the guarantees that were implicit (one
clock, one tenant, one reader) become explicit engineering. The discipline the
design docs show — forward-compat columns, a contract seam (`VectorStore`),
named-but-unbuilt prerequisites — is how you keep that transition additive
instead of a rewrite. The parent doc frames the whole thing as a learning +
portfolio project deliberately *not* building the platform early
(`agent-layer-plan.md` lines 5-7, "What it is NOT"). For the architectural
shape of this migration go to `study-system-design`; for what one Postgres
guarantees under the hood go to `study-database-systems`.

## Interview defense

**Q: You store trajectory order as a wall-clock timestamp. Doesn't that break
the moment you add a second device?**

Yes — and that's the headline prerequisite, named not hidden. Verdict: on one
device the physical clock is a valid total order; on two it's not.

```
  1 clock → ORDER BY created_at ✓ total order
  2 clocks → ORDER BY created_at ✗ → logical clock (per-conv sequence)
```

The signal here is knowing *which* free guarantee I'm spending: single-writer
made the physical clock a total order; the second writer retires that, so the
fix is a logical clock, designed in *before* the phone ships, not after it
corrupts a trajectory. Anchor: `src/supabase-trace-sink.ts:54`,
`src/session.ts:30` — the exact two lines that change.

**Q: `app_id` isolates tenants today. Is that secure?**

Today it's not a security boundary — it's a convention, and that's fine because
there's exactly one writer. The design names RLS + JWT-derived `app_id` as a
hard prerequisite before app #2 (design lines 191-195). The load-bearing rule:
derive `app_id` from the token, never the request body — otherwise a client just
claims another tenant's id. That's a *deferred* control, correctly not built for
a single trusted writer.

## See also

- `00-overview.md` — the "what's deferred" section.
- `02-trace-sink-write-buffering.md` — prerequisite 1 (the clock) set up in
  today's code.
- `audit.md` — lens 4 (consistency), lens 5 (replication), lens 7 (clocks).
- `study-system-design` — the architectural shape of this migration.
- `study-database-systems` — RLS and what one Postgres guarantees.
- Source design docs: `agent-layer-plan.md`,
  `docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md`.
