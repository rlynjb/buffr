# app_id Tenant Column (multi-tenant in shape only)

**Industry names:** tenant discriminator column / shared-schema
multi-tenancy / discriminator-based isolation. **Type:** Industry standard
(here, present but inert).

## Zoom out, then zoom in

Here's the column that's on every table, and the boundary it does *not* yet
enforce.

```
  Zoom out — where app_id sits and what's missing

  ┌─ Service layer (the app) ───────────────────────────┐
  │  loadConfig(env).appId   default 'laptop'            │  ★ source of app_id
  │           │  NOT derived from any auth token         │
  └───────────┼──────────────────────────────────────────┘
              │  passed as constructor arg
  ┌─ Storage layer (Postgres) ▼──────────────────────────┐
  │  every table: app_id text not null default 'laptop'  │
  │  queries: where app_id = $2    ← app CHOOSES to apply │
  │  ✗ no RLS  ✗ no policy  ✗ no DB-enforced boundary    │  ← we are here
  └──────────────────────────────────────────────────────┘
```

**Zoom in.** Every table carries `app_id`. Every read filters on it. It
*looks* like multi-tenancy. But the value comes from an env var, not an
authenticated identity, and the database enforces nothing — any query that
forgets `where app_id` sees every tenant. The question: *what's actually
isolated here, and what only appears to be?*

## The structure pass

**Layers:** (1) the column `app_id` on all five tables. (2) the app-side
filter `where app_id = $2` in each read. (3) the *absent* DB enforcement — no
RLS, no policy. The isolation is real at layer 2, imaginary at layer 3.

**Axis — trust (what stops one tenant reading another's rows):** trace it.
At the column, nothing — it's just text. At the query, the *application*
stops it, *if* the developer wrote the filter. At the DB, nothing — there's
no policy. So the answer to "what enforces tenant isolation" is "developer
discipline," at every layer. Nowhere does it become "the database."

**Seam:** the load-bearing boundary is **filter-by-convention vs
enforced-by-RLS**. Today crossing into another tenant's data takes one
forgotten `where` clause. With RLS, the DB would reject the cross-tenant read
regardless of the query. That seam is exactly where this stops being real
multi-tenancy.

## How it works

### Move 1 — the mental model

You know how a client-side `if (user.isAdmin)` guard is worthless if the API
doesn't *also* check — because anyone can skip the client? `app_id` filtering
without RLS is that: a guard in the layer that can be bypassed, with no guard
in the layer that can't. The filter is the client-side check; RLS would be
the server-side one. Right now only the bypassable layer exists.

```
  app_id today — the guard is in the bypassable layer

  ┌─ app query ─────────────────────────────────────────┐
  │  where app_id = $2     ← present IF dev remembers it │  bypassable
  └───────────────────────┬──────────────────────────────┘
                          │  forget it once →
  ┌─ database ────────────▼──────────────────────────────┐
  │  (no RLS policy)       ← returns ALL tenants' rows    │  no backstop
  └──────────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Where `app_id` comes from.** `loadConfig` reads `AGENT_APP_ID` from env,
defaulting to `'laptop'` (`src/config.ts:12`). That value is passed into
`PgVectorStore`'s constructor (`src/pg-vector-store.ts:27`) and used as a
bound parameter. **It is not derived from an authenticated token, session, or
JWT claim.** There is no auth in the system at all — it's single-device. So
`app_id` is a *configuration constant*, not an *identity*.

**Where it's applied.** Reads filter on it: vector search
(`pg-vector-store.ts:75`, `where app_id = $2`), profile load
(`src/profile.ts:5`, `where app_id = $1`). Writes stamp it: chunk upsert
(`pg-vector-store.ts:55`), document insert (`src/runtime.ts:12`), conversation
start (`src/supabase-trace-sink.ts:6`), and memory writes — which go through
the same `PgVectorStore.upsert` (`src/session.ts:53,67`), so each
`memory:<conv>:<n>` row is stamped with the store's `appId` exactly like a
corpus chunk. The discipline is consistent — every current write path stamps
it, every read filters it.

**Where the boundary isn't.** There is no `enable row level security`, no
`create policy` anywhere in `sql/001_agents_schema.sql`. So the only thing
between tenant A and tenant B is that every query *remembers* its `where
app_id`. The `chunks_app_id` index (`:30`) optimizes the filter but doesn't
enforce it — an index makes the filter fast, not mandatory.

**Where it breaks.** Add one new read path — say a "list all recent
conversations" admin query — and forget the `where app_id`, and it returns
every tenant's conversations. No error, no rejection. The DB has no opinion.
At one tenant (`'laptop'`) this is harmless; the moment `app_id` has a second
value, it's a data-leak waiting on a forgotten clause.

### Move 2.5 — current state vs future state

```
  Phase A (now)                  Phase B (real multi-tenancy)
  ─────────────                  ────────────────────────────
  app_id from env constant       app_id from auth token claim
  filter by convention           RLS policy: USING (app_id = current_setting)
  forget where → leak            forget where → DB still filters
  one tenant ('laptop')          many tenants, DB-isolated

  what DOESN'T change: the column, the index, every existing query.
  RLS layers UNDER them. The shape is already right; the enforcement
  is the missing half.
```

The payoff worth naming: the schema is *already shaped* for multi-tenancy.
Turning it on is additive — enable RLS, write one policy per table, derive
`app_id` from a token. No table redesign. The column did its job by existing.

### Move 3 — the principle

A tenant discriminator column is necessary but not sufficient for isolation.
The column lets you *filter*; only an enforced policy (RLS) makes the filter
*mandatory*. Shipping the column without the policy is a legitimate phase —
it gets the shape right while the app is single-tenant — but it must be named
as "isolation in shape only," never mistaken for the real thing. The day a
second `app_id` appears, the missing half becomes load-bearing.

## Primary diagram

```
  app_id across the stack — present everywhere, enforced nowhere

  ┌─ config ─────────────────────────────────────────────┐
  │  AGENT_APP_ID → 'laptop'   (env constant, not identity)│
  └───────────────────────┬───────────────────────────────┘
                          │  constructor arg / bind param
  ┌─ queries ─────────────▼───────────────────────────────┐
  │  WRITE: ...app_id... stamped on every insert           │
  │  READ:  where app_id = $2   (only if remembered)       │
  └───────────────────────┬───────────────────────────────┘
                          │
  ┌─ database ────────────▼───────────────────────────────┐
  │  app_id text not null default 'laptop'  (5 tables)     │
  │  chunks_app_id index (speeds filter, doesn't enforce)  │
  │  ✗ NO RLS  ✗ NO POLICY  → boundary does not exist here  │
  └─────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use case.** Every read and write stamps or filters `app_id`. Today it's
always `'laptop'`, so the filter is effectively a no-op — but it's the seam
that would carry real isolation if buffr ever served more than one app/user.

**The column — `sql/001_agents_schema.sql:6,19` (and on every table):**

```
  app_id text not null default 'laptop'
        │            │              │
        │            │              └─ default makes single-tenant frictionless
        │            └─ not null: every row HAS a tenant, good
        └─ but it's a plain column — no policy references it
```

**The filter — `src/pg-vector-store.ts:75`, `src/profile.ts:5`:**

```
  where app_id = $2            ← search; $2 is the config constant
  where app_id = $1            ← profile load
       │
       └─ this is the ENTIRE isolation mechanism. Remove it and the
          query crosses tenants. The DB won't stop you.
```

**The source — `src/config.ts:12`, `src/pg-vector-store.ts:27`:**

```
  appId: env.AGENT_APP_ID || 'laptop',    ← from ENV, not from a token
  ...
  this.appId = opts.appId ?? 'laptop';    ← constructor arg, trusted as-is
       │
       └─ no auth → app_id is configuration, not authenticated identity.
          The "tenant" is whoever set the env var.
```

## Elaborate

Shared-schema multi-tenancy with a discriminator column is the lightest of
the three tenancy models (vs schema-per-tenant, DB-per-tenant). Its known
failure mode is exactly this one: isolation depends on every query carrying
the discriminator, and one missed `where` leaks across tenants. Postgres RLS
exists to close that — a policy makes `app_id` filtering happen *below* the
query, so forgetting the clause is harmless. The trust analysis (what an
attacker or a buggy path can reach) belongs to `study-security`; the *shape*
question — is the column the right modeling choice — is here, and the answer
is yes, the column is right, the enforcement is the deferred half.

## Interview defense

**Q: You have `app_id` on every table. Is this multi-tenant?**

```
  shape:        ✓ column present, ✓ filtered, ✓ indexed
  enforcement:  ✗ no RLS, ✗ app_id not token-derived
  verdict:      multi-tenant in SHAPE only
```
Answer: in shape, not in enforcement. The column's on every table and every
query filters it — but the value comes from an env var, not an auth token,
and there's no RLS, so isolation is one forgotten `where` clause from
breaking. At one tenant it's fine; it's deliberately phase-one. The fix is
additive: enable RLS, one policy per table, derive `app_id` from a token — no
schema redesign, because the column's already there. **Anchor:**
`config.ts:12` (env, not token) + no RLS in `sql/001_agents_schema.sql`.

**Q: What's the single most dangerous line if this went multi-tenant
tomorrow?**

Any read missing `where app_id`. There's no DB backstop, so the first
forgotten filter leaks every tenant's rows. **Anchor:** the mechanism is
entirely `pg-vector-store.ts:75` / `profile.ts:5` — app-side, bypassable.

## Validate

1. **Reconstruct:** name the two halves of tenant isolation (column +
   enforcement) and which half this repo has.
2. **Explain:** why does the `chunks_app_id` index not provide isolation?
   (`sql/001_agents_schema.sql:30`)
3. **Apply:** add a "recent conversations" query and show how forgetting one
   clause leaks across tenants.
4. **Defend:** why is shipping the column without RLS a legitimate phase, and
   exactly when does that stop being true?

## See also

- `06-trajectory-tables.md` — conversations/messages also carry `app_id`.
- `audit.md` §7 — RLS and token-derivation under "not yet exercised."
- `study-security` — the trust-boundary / data-exposure analysis.
- `study-system-design` — why single-device defers the tenancy work.

---
Updated: 2026-06-24 — no-RLS / not-token-derived findings unchanged; noted
memory writes (`@aptkit/memory` via the shared `PgVectorStore`) also stamp
`app_id` on `memory:<conv>:<n>` rows.
