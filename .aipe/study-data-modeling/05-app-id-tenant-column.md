# 05 · app_id tenant column

**Subtitle:** a multi-tenant discriminator column present on every table — tenancy
*shape* without row-level enforcement — *Industry standard (shape only)*.

---

## Zoom out, then zoom in

Every table in the schema carries `app_id text not null default 'laptop'`. It's
the column you'd reach for to isolate one application's (or user's) data from
another's in a shared database. The catch: here it's a *shape*, not a *boundary*
— it filters reads, but nothing in the database stops a query from reading across
it.

```
  Zoom out — where app_id sits, and what's missing above it

  ┌─ Trust boundary (NOT present) ──────────────────────────┐
  │  no auth token → no token-derived app_id   ✗            │
  └───────────────────────────┬─────────────────────────────┘
                              │  app_id = constructor default 'laptop'
  ┌─ App layer ───────────────▼─────────────────────────────┐
  │  PgVectorStore(appId) → where app_id = $2                │
  └───────────────────────────┬─────────────────────────────┘
                              │
  ┌─ Storage: agents (every table) ──▼──────────────────────┐
  │  app_id text not null default 'laptop'   ★ the column ★  │ ← here
  │  NO row-level security policy            ✗ (not present) │
  └─────────────────────────────────────────────────────────┘
```

Zoom in: the question is "if two apps shared this database, would one be able to
read the other's rows?" Today the answer is "there's only one app, so it never
comes up." But the *mechanism* — a filter column with no RLS and no token
derivation — means the isolation lives entirely in remembering to write
`where app_id = $x`. Forget it once and the boundary is gone.

## The structure pass

One axis: **trust** — what can each side see or tamper with? Trace it from the
column up to where a real boundary *would* be.

```
  axis = "what stops a query from reading another app's rows?"

  ┌─ a real tenant boundary (RLS) ─┐   DB enforces: yes, per-row
  │  policy: app_id = current_app  │   → forget the filter → DB still blocks
  └────────────────┬────────────────┘
                   │ seam: this layer is ABSENT here
  ┌─ this repo (filter only) ──────┐   DB enforces: nothing
  │  where app_id = $2 in app code │   → forget the filter → full leak
  └─────────────────────────────────┘

  the boundary that should flip "trust" is missing → app_id isolates nothing
```

The seam is the RLS layer that *isn't there*. With RLS, `app_id` is a boundary
the DB defends row by row regardless of what the query says. Without it, `app_id`
is a convention — load-bearing only as long as every query author remembers it.

## How it works

### Move 1 — the mental model

The shape is a **discriminator column** — the same idea as a `type` or `tenant_id`
field you filter on in any multi-tenant app. It's the right *shape* for tenancy.
What makes it a boundary vs a suggestion is whether something *enforces* the
filter. Think of `where user_id = ?` in a query: it isolates correctly until the
one endpoint that forgets it, and then it's an IDOR.

```
  filter-column tenancy (pattern)

  app_id='laptop' rows   ┐
  app_id='other'  rows   ┘  same table, mixed tenants

  read with WHERE app_id='laptop'   → laptop rows only   ✓ (if remembered)
  read WITHOUT the where clause      → BOTH tenants        ✗ (no DB stop)
```

### Move 2 — the walkthrough

**The column, on every table, with a default.**

```
  File: sql/001_agents_schema.sql
  Lines: 6, 18-19, 34, 53 (one per table)

    documents:     app_id text not null default 'laptop'   :6
    chunks:        app_id text not null default 'laptop'   :19
    conversations: app_id text not null default 'laptop'   :34
    profiles:      app_id text not null default 'laptop'   :53
```

`not null default 'laptop'` is the shape decision. Every row is tagged; the
default means a writer that forgets to set it still gets a consistent tag.
(`messages` is the exception — it has no `app_id`; it reaches its tenant through
`conversation_id → conversations.app_id`, the one real FK. That's correct
normalization: the tenant of a message is the tenant of its conversation.)

**Where it's filtered — the one hot path.**

```
  File: src/pg-vector-store.ts
  Function: PgVectorStore.search
  Lines: 70-77

    select id, content, ..., 1 - (embedding <=> $1::vector) as score
    from agents.chunks
    where app_id = $2                ← THE filter, in app code
    order by embedding <=> $1::vector
    limit $3
                       [toVectorLiteral(vector), this.appId, k]
                                                   └─ this.appId
```

The `where app_id = $2` is the entire isolation mechanism for the search path. It
works. But it's *one query author remembering*, not a rule the DB imposes.

**Where `appId` comes from — and what it is NOT.**

```
  File: src/pg-vector-store.ts
  Constructor + src/session.ts:41
  Lines: 25-30

    this.appId = opts.appId ?? 'laptop';   ← a constructor default
    // session.ts:41
    new PgVectorStore({ pool, appId: cfg.appId, ... })
                                    └─ cfg.appId from AGENT_APP_ID env (context.md)
```

This is the security-relevant line. `appId` is a *configuration value* — an env
var with a default — **not** something derived from an authenticated token. In a
real multi-tenant system the tenant id must come from the verified identity of
the caller, so a user can't ask for another tenant's data by changing a
parameter. Here it's a process-wide constant. For a single-device personal agent
that's exactly right; as a tenancy boundary it's nothing.

```
  Layers-and-hops — where the tenant id is decided

  ┌─ env ─────────┐ AGENT_APP_ID    ┌─ config ────┐ cfg.appId  ┌─ store ──┐
  │ 'laptop'      │ ──────────────► │ loadConfig  │ ─────────► │ this.appId│
  └───────────────┘                 └─────────────┘            └─────┬─────┘
        ▲                                                            │ where
        │  NOT a token. NOT per-request. process-wide.               ▼ app_id=$2
        │                                              ┌─ Postgres ──────────┐
        └──── a real boundary would derive this ──────│ filters, no RLS check│
              from auth per request                    └──────────────────────┘
```

**The boundary condition — exactly where it breaks.** The isolation holds for
every query that includes `where app_id = ?`. It breaks the moment: (a) a second
`app_id` value shares the database, AND (b) any query omits the filter — an
admin script, a new feature, a `select * from chunks` for debugging. With no RLS,
the DB happily returns every tenant's rows. There's also no `app_id` index on
`documents`, `conversations`, or `profiles` (only `chunks` has
`chunks_app_id`, `001:30`) — so even as a filter it's only index-backed on the
one hot table.

### Move 2.5 — current state vs future state

This is built-but-deliberately-partial. The shape is in; the enforcement is
gated to a later phase (context.md: "**No RLS this phase.**").

```
  Phase A — now (single device)        Phase B — multi-tenant (gated)
  ──────────────────────────────       ───────────────────────────────
  app_id column present       ✓        app_id column present        ✓ (no change)
  app_id = env default 'laptop'        app_id = token-derived per request
  filter in app code only              RLS policy: app_id = current_setting(...)
  no RLS                               DB enforces row-by-row
  one tenant → boundary moot           N tenants → boundary real

  what does NOT change: the column, the writes, the search filter.
  what's added: token derivation + RLS policies. The shape was built
  forward-compatible on purpose.
```

The takeaway is *what doesn't have to change*: the column is already on every
table with the right type and default, so Phase B is additive — add RLS policies
and derive `app_id` from auth. You don't reshape the schema; you add the
enforcement layer that was deferred.

### Move 3 — the principle

A tenancy *column* and a tenancy *boundary* are different things, and conflating
them is how multi-tenant data leaks ship. The column is the shape — every row
knows its tenant. The boundary is the enforcement — the DB refuses cross-tenant
reads no matter what the query says (RLS) and the tenant id comes from verified
identity, not a parameter. This repo has the shape, correctly, and has
*deliberately deferred* the boundary because there's one tenant. The discipline
worth copying: build the column forward-compatible now so the boundary is
additive later — don't bolt tenancy onto a schema that never had the column.

## Primary diagram

The whole tenancy story — shape present, boundary deferred.

```
  app_id — shape without enforcement (and the gap to a real boundary)

  ┌─ every table ───────────────────────────────────────────┐
  │  app_id text not null default 'laptop'   ← SHAPE: present│
  └──────────────────────┬───────────────────────────────────┘
                         │
        ┌────────────────┴─────────────────┐
        │ filter (app code)                │ boundary (DB) ── MISSING
        │  search: where app_id=$2  ✓      │  RLS policy      ✗
        │  other reads: no filter   ✗      │  token-derived id ✗
        └──────────────────────────────────┘
                         │
        isolation = "remember the filter"  ← holds for 1 tenant,
                                             leaks the day a 2nd appears
```

## Elaborate

Shared-schema multi-tenancy (one set of tables, a `tenant_id` discriminator) is
the most common SaaS tenancy model — cheaper than schema-per-tenant or
database-per-tenant, at the cost of needing airtight filtering. Postgres RLS is
the tool that makes the filtering airtight: policies move the `where tenant_id =
...` from every query into one place the engine enforces, so a forgotten filter
can't leak. This repo's choice to ship the column without RLS is fine for one
device and is a known, named gap — the *security* read of this exact column
(trust boundary, token derivation, IDOR risk) lives in `study-security`; here we
care that the column's *shape* is right and forward-compatible. Whether to scale
this to many tenants at all is a `study-system-design` question.

## Interview defense

**Q: You have `app_id` on every table but no RLS. Is that a security hole?**

Today, no — there's one tenant, `'laptop'`, and the search path filters on it.
But it's a *boundary that isn't enforced*: isolation depends on every query
remembering `where app_id = ?`, and `app_id` is an env-var default, not derived
from an authenticated token. The moment a second tenant shares the database, any
query that forgets the filter leaks across tenants and the DB won't stop it. The
fix is additive — RLS policies plus token-derived `app_id` — because the column
is already there.

```
  shape: app_id on every table         ✓ done
  boundary: RLS + token-derived id     ✗ deferred (Phase B)
  risk: real only at 2+ tenants; until then, moot but pre-wired
```

Anchor: "a discriminator column is tenancy's shape; RLS plus token derivation is
its boundary — I built the shape forward-compatible and deferred the boundary on
purpose."

**Q: Why does `messages` not have an `app_id` column?**

Because a message's tenant is fully determined by its conversation — `messages`
has a real FK to `conversations`, and `conversations` carries `app_id`. Adding
`app_id` to `messages` would duplicate that fact and let the two disagree. It's
the one place the schema normalizes the tenant through a relationship instead of
copying it, and that's correct.

## See also

- `06-trajectory-tables.md` — why `messages` reaches its tenant through the FK.
- `03-soft-link-no-fk.md` — the FK that *does* exist, carrying tenant down to
  messages.
- `audit.md` Lens 4 — integrity, including app_id-as-filter-not-boundary.
- `study-security` — the trust-boundary read: token derivation, RLS, IDOR.
