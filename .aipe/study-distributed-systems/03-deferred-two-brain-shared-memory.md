# Deferred: Two-Brain Shared Memory

**Multi-writer shared state / convergence** · Industry standard · **DESIGN-NOT-CODE**

> ⚠️ **This file describes a problem that is NOT built.** Nothing in `src/`
> implements any of it. It exists in `agent-layer-plan.md` and the graduation
> design spec as a *future* phase, explicitly deferred. It earns a file because
> it is the one place where buffr's trajectory becomes a genuine
> distributed-systems problem — and naming the problem now is how you reason
> about the single-device code that *will* have to grow into it. Every
> mechanism below is design, not code. There are no `file:line` anchors to
> implementation because there is no implementation — only to the design docs.

---

## Zoom out, then zoom in

Today buffr is one writer. The deferred plan adds a second brain — a phone —
and both write the *same* Supabase `agents` schema through an HTTP gateway. The
moment that second writer exists, every `not yet exercised` lens in `audit.md`
turns on at once.

```
  Zoom out — the deferred two-brain topology (NOT BUILT)

  ┌─ Laptop brain ──────┐         ┌─ Phone brain ───────┐
  │ buffr (built today) │         │ RN + on-device model │
  │ local cache?        │         │ local cache?         │
  └──────────┬──────────┘         └──────────┬──────────┘
             │ HTTPS, JWT(app_id)            │ HTTPS, JWT(app_id)
             ▼                               ▼
  ┌─ Edge Functions (the agent API) ─ ★ DEFERRED ★ ───────────┐
  │  /search /documents /conversations/:id/messages           │
  └────────────────────────────┬──────────────────────────────┘
                              writes │ RLS by app_id
  ┌─ Supabase Postgres ────────▼──────────────────────────────┐
  │  agents schema — ONE shared memory, TWO writers           │ ← the problem
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **multi-writer shared state with convergence and
isolation.** Two independent clients, each possibly with a local cache,
read and write one authoritative store. The questions it forces — and that the
single-device code never has to answer — are: *whose write wins when they
conflict? does a write on the laptop become visible to the phone, and when? can
one brain read its own writes? and what stops the phone from reading the
laptop's private memory?* None of these have answers in `src/` because there's
one writer and one reader and they're the same device.

---

## Structure pass

**Layers.** Three in the deferred design: the **brains** (laptop, phone — each a
client), the **gateway** (Edge Functions enforcing auth/RLS), and the **shared
store** (one Postgres). The gateway is the new seam that doesn't exist today.

**Axis — trace *state ownership / visibility* across the brains.** Hold the
question: *"when brain A writes, when and how does brain B see it?"*

```
  One question across the topology: "A writes — when does B see it?"

  TODAY (built):        one brain → one store → reads its own writes instantly
                        no B exists. visibility question is VACUOUS.

  DEFERRED:
  ┌─ Laptop writes ─────┐
  │ commit to Postgres   │  → durable immediately
  └──────────┬───────────┘
             │ the visibility answer flips at each layer below
  ┌─ Phone's local cache ▼┐
  │ stale until it re-reads │ → eventually consistent (cache convergence)
  └──────────┬─────────────┘
  ┌─ Phone's next /search ─▼┐
  │ reads shared store      │ → sees laptop's write (read-through)
  └─────────────────────────┘
```

**Seam — the gateway is load-bearing for *trust and isolation*; the local
caches are load-bearing for *consistency*.** Today neither seam exists. In the
deferred design, the gateway is where `app_id` stops being a convention and
becomes an enforced RLS boundary derived from the JWT (the design spec's open
question calls this "a hard prerequisite before a second app writes"). The local
caches are where staleness and convergence enter — a problem that simply has no
surface in the single-device code.

---

## How it works

### Move 1 — the mental model

You know optimistic UI: the client updates its local view immediately, then
reconciles with the server, and you have to decide what happens if the server
disagrees. Two brains over one store is that, doubled and symmetric — *both*
sides are clients with local views of one authoritative state, and now the
conflict can be between two clients, not just client-vs-server.

```
  Pattern — two writers, one authoritative store, convergence

         brain A ──write──┐         ┌──write── brain B
                          ▼         ▼
                   ┌─────────────────────┐
                   │  shared store (truth)│  ← serializes writes
                   └──────────┬──────────┘
              read-through    │   read-through
                  ▲           │           ▲
         A's cache (may be stale) ── B's cache (may be stale)
                  └──── converge on next read ────┘
```

The kernel: **one authoritative store that serializes writes + per-client caches
that converge on read + a conflict policy for concurrent writes to the same
row.** Drop the authoritative store and you have two divergent truths with no
referee. Drop the conflict policy and concurrent writes silently clobber. Drop
read-through convergence and the caches drift forever.

### Move 2 — the walkthrough (what the design implies, not what exists)

**The shared store serializes writes — so there's a single truth.** Bridge from
the single Postgres buffr already uses: keep *one* database as the authority and
the hard part (two divergent copies) never arises, because both brains commit to
the same rows. What the design concretely says: both phone and laptop POST to
the same Edge Functions writing the same `agents.*` tables (`agent-layer-plan.md`
architecture diagram). Where it breaks: this only holds while there's *one*
store. The instant a brain caches writes locally and goes offline, you've
reintroduced two truths and need sync/merge — which is why the design keeps the
store central and defers any offline-write story.

```
  Layers-and-hops — a write from each brain (DEFERRED design)

  ┌─ Laptop ─┐ POST /messages  ┌─ Edge Fn ─┐ insert  ┌─ Postgres ─┐
  │ brain    │ ───────────────► │ verify JWT │ ──────► │ agents.*   │
  └──────────┘                  │ set app_id │         │ (RLS)      │
  ┌─ Phone ──┐ POST /messages  │ from token │ ──────► │            │
  │ brain    │ ───────────────► └────────────┘         └────────────┘
  └──────────┘  app_id NEVER from request body — always from the JWT claim
```

**Isolation moves from convention to enforcement.** Today `app_id` defaults to
`'laptop'` and is a *filter* the trusted single client passes
(`pg-vector-store.ts:74` does `where app_id = $2`). The design is explicit that
this is "isolation by convention only until app #2," and that the fix is RLS:
`USING (app_id = current_setting('request.jwt.claim.app_id'))`, with `app_id`
*always* derived from the token. What concretely changes: a buggy or hostile
phone client can no longer read laptop rows by passing the wrong `app_id`,
because the database itself scopes every query to the JWT's claim. Where it
breaks if skipped: with RLS deferred and `app_id` trusted from the client, a
second writer is a confused-deputy hole — the design names this as a hard
prerequisite, not an optimization.

**Consistency becomes a real question — read-your-writes and staleness.** Today
it's vacuous: one device reads its own writes from the one store immediately.
With two brains plus local caches, you have to ask whether a brain reads its own
writes (yes, if it read-throughs to the store; no, if it serves from a stale
local cache) and how stale the *other* brain's view is. The design's answer is
to keep reads going through the store (`/search` hits Postgres), which gives
read-your-writes per brain and bounded staleness for the peer — at the cost of a
network round-trip per read.

### Move 2.5 — current state vs future state (the whole point of this file)

This *is* the comparison. The takeaway is how little of the built code has to
change, because the contracts were chosen to absorb it.

```
  Comparison — single-device (BUILT) vs two-brain (DEFERRED)

  BUILT (src/ today)                  DEFERRED (design only)
  ┌──────────────────────────┐        ┌──────────────────────────────┐
  │ 1 writer (app_id=laptop)  │        │ 2+ writers (laptop, phone)    │
  │ direct pg.Pool            │        │ HTTPS → Edge Functions        │
  │ app_id = trusted filter   │   →    │ app_id = RLS from JWT claim   │
  │ read-your-writes (trivial)│        │ caches + convergence + staleness│
  │ no conflict policy needed │        │ concurrent-write conflict policy│
  │ ordering bug is mild      │        │ ordering bug now cross-device  │
  └──────────────────────────┘        └──────────────────────────────┘
  what DOESN'T change: the VectorStore contract. PgVectorStore swaps its
  transport (pg → HTTP) without the agent noticing. The schema's app_id /
  user_id / embedding_model columns already exist for exactly this.
```

The migration cost is concentrated in two places: adding RLS + token-derived
`app_id` (a security/isolation change), and deciding a conflict policy if the
same row can be written from two brains. The agent loop, the retrieval pipeline,
and the `VectorStore` interface are untouched — that's the deliberate payoff of
the forward-compat schema and the contract-first design.

### Move 3 — the principle

The single-writer code you have today is the *degenerate case* of the
multi-writer problem — every distributed-consistency question has a trivial
answer because there's exactly one of everything. That's not a weakness; it's
the right place to stop until a second writer actually exists. The discipline
worth carrying: the project chose its seams (the `VectorStore` contract, the
`app_id`/`user_id` columns, one central store) so that adding the hard part
later is a *substitution at known boundaries*, not a rewrite. The principle is
**defer the distributed-systems complexity, but pick your contracts so the
deferral is cheap to reverse** — which is exactly what the design did.

---

## Primary diagram

The complete deferred picture, with the parts that don't exist clearly marked.

```
  Two-brain shared memory — the complete DEFERRED design (NOT BUILT)

  ┌─ Laptop brain (buffr, BUILT) ─┐   ┌─ Phone brain (NOT BUILT) ─────┐
  │ RagQueryAgent · PgVectorStore │   │ RN · on-device model          │
  │ [ local cache? — undecided ]  │   │ [ local cache? — undecided ]  │
  └───────────────┬───────────────┘   └───────────────┬───────────────┘
                  │ HTTPS JWT(app_id)                  │ HTTPS JWT(app_id)
  ┌─ Edge Functions (DEFERRED) ───▼────────────────────▼──────────────┐
  │  enforce RLS · app_id ALWAYS from token, never request body       │
  └────────────────────────────┬──────────────────────────────────────┘
                  serialized    │   writes
  ┌─ Supabase Postgres (BUILT today, single-writer) ──▼───────────────┐
  │  agents schema — the ONE authoritative shared memory              │
  │  needs: RLS policies · a same-row conflict policy · cross-device  │
  │         message ordering (the seq fix from file 02, now critical) │
  └───────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** There are none in `src/` — that is the finding. The *design*
use case (from `agent-layer-plan.md` and the graduation spec): a phone captures
a conversation on the go, the laptop indexes a corpus at the desk, and both want
one shared memory so the agent's knowledge and trajectory are continuous across
devices. The plan's portfolio thesis is "capture every conversation as a
trajectory now so fine-tuning is answerable later" — which only pays off if both
brains write the same `agents.messages`.

**The seam that makes the deferral cheap — `src/pg-vector-store.ts` (lines
19-30).**

```
  export class PgVectorStore implements VectorStore {   ← aptkit's contract
    readonly dimension: number;
    constructor(opts: PgVectorStoreOptions) {
      this.appId = opts.appId ?? 'laptop';              ← the future tenant key,
      ...                                                  today a default filter
    }
       │
       └─ Because the agent depends on the VectorStore INTERFACE, not on pg,
          the two-brain phase swaps THIS class's transport (pg → HTTP gateway)
          with zero agent changes. The deferral is cheap precisely here.
```

**The isolation-by-convention that the design flags as a prerequisite —
`src/pg-vector-store.ts` (lines 67-78).**

```
  where app_id = $2          ← single trusted client passes its own app_id.
                                Fine for one writer; a confused-deputy hole
                                the moment a second, untrusted client writes.
       │
       └─ The design's open question: "isolation is by convention only until
          app #2. Adding RLS + always-derive-app_id-from-token is a hard
          prerequisite before a second app writes." (graduation spec).
          NOT a line to change now — a line to remember when the phone arrives.
```

**The forward-compat columns that pre-pay the migration — `sql/001_agents_schema.sql`.**

```
  app_id text not null default 'laptop',   (every table)   ← tenant key, ready
  user_id text,                            (conversations) ← per-user, ready
  embedding_model text not null default ...(chunks)        ← embedder swap door
       │
       └─ These columns do nothing useful for a single writer. They exist so
          the two-brain phase needs NO schema migration to start scoping by
          tenant/user — "cheap now, painful to retrofit" (design decision table).
```

---

## Elaborate

Multi-writer shared state is the foundational distributed-systems problem —
it's what CRDTs, vector clocks, quorum systems, and last-writer-wins policies
all exist to answer. The design here sidesteps almost all of it with one move:
**keep a single authoritative store and route every write through it**, so the
store serializes writes and there's never two divergent truths to merge. That's
the cheapest correct answer, and it holds as long as no brain writes offline. The
day an offline-capable phone caches writes locally is the day this stops being a
"route through one store" problem and becomes a real sync/merge problem — and
the design explicitly defers offline writes to avoid exactly that. Read the
graduation spec's "Out of scope" and "Open questions" sections: every hard part
is named and pushed out, which is the correct way to defer.

What to read next: `audit.md` — Lenses 4, 5, 7 all say `not yet exercised` and
point here as the phase that activates them. `01-app-to-postgres-boundary.md`
Move 2.5 shows the same direct-pg → HTTP-gateway transition from the boundary's
side. `.aipe/study-system-design/` covers the local-first / cloud-mirror
architecture decisions in depth.

---

## Interview defense

**Q: "buffr is single-device. Why does a distributed-systems study even mention
two brains?"**

```
  single-writer is the degenerate case of multi-writer

  TODAY:  [one brain] → [store]      every consistency Q has a trivial answer
  LATER:  [A] [B] → [store]          the same questions get real answers
```

Because the *interesting* distributed-systems problem in this project is
designed but deferred, and the right way to handle a deferred hard problem is to
pick your contracts so adding it later is a substitution, not a rewrite. The
single-writer code is the degenerate case — one of everything, so every
consistency question is trivial. I'd point at the `VectorStore` interface and
the forward-compat `app_id`/`user_id` columns: those are the deferral being made
cheap on purpose.

*Anchor: `pg-vector-store.ts:19` (the swappable contract), `sql/001_agents_schema.sql` (the pre-paid columns).*

**Q: "When the phone arrives, what's the first thing that has to change?"**

RLS plus token-derived `app_id`. Today `where app_id = $2` trusts a single
client to pass its own tenant key — fine for one writer, a confused-deputy hole
the instant a second untrusted client writes. The design names this as a hard
prerequisite: RLS on every `agents.*` table with `app_id` always derived from
the JWT claim, never the request body. The *second* thing is a same-row conflict
policy and a real cross-device message ordering — which is when the mild
ordering bug from file 02 stops being mild.

*Anchor: `pg-vector-store.ts:74` (the convention-only filter) and the graduation spec's open question on RLS.*

---

## Validate

1. **Reconstruct.** From memory, draw the deferred topology: two brains → Edge
   Functions (RLS) → one shared store. Mark which boxes exist today (the store,
   the laptop) and which don't (the gateway, the phone).
2. **Explain.** Why does keeping one authoritative store sidestep most of the
   multi-writer problem? What single assumption breaks that (offline writes)?
3. **Apply.** A phone is about to ship. Sequence the changes: (a) RLS +
   token-derived `app_id` at `pg-vector-store.ts:74`, (b) a same-row conflict
   policy, (c) the `seq`-column ordering fix from file 02 — and say why that
   order.
4. **Defend.** Argue that deferring all of this was the right call for a
   single-device portfolio project, citing the design spec's "Out of scope"
   list and the forward-compat columns that make the deferral reversible.

---

## See also

- `audit.md` — Lenses 4 (consistency), 5 (replication/partitioning), 7 (clocks)
  all point here as the phase that would activate them.
- `01-app-to-postgres-boundary.md` — Move 2.5 shows the direct-pg → HTTP-gateway
  transition from the boundary's side.
- `02-trace-sink-write-buffering.md` — the ordering bug that becomes critical
  once two devices write `agents.messages`.
- `.aipe/study-system-design/` — the local-first / cloud-mirror architecture and
  scale tradeoffs in depth.
- `agent-layer-plan.md` and `docs/superpowers/specs/2026-06-19-laptop-supabase-graduation-design.md`
  — the source design docs for everything in this file.
