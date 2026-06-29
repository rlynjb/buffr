# `app_id` tenant column (shape only, no RLS)

**Industry name(s):** tenant discriminator column / multi-tenancy by shared
table — here the tenant discriminator (`app_id`). **Type:** Industry standard
(discriminator-column multi-tenancy), shipped shape-only.

---

## Zoom out, then zoom in

You know the shared-table multi-tenancy pattern: instead of a database per
customer, one set of tables with a `tenant_id` column on every row, and every
query filters by it. This file is about that column (`app_id`) present on all
five tables — and the honest fact that the *enforcement* half of the pattern
(Row-Level Security) isn't wired up yet. The shape is here; the guard is not.

```
  Zoom out — where app_id sits, and where its guard ISN'T

  ┌─ env / config ───────────────────────────────────────────┐
  │  AGENT_APP_ID (default 'laptop')  ── NOT token-derived     │ ← trust note
  └───────────────────────────────┬───────────────────────────┘
                                  │  passed in, not authenticated
  ┌─ app (PgVectorStore, runtime) ▼───────────────────────────┐
  │  every query carries app_id = $  ── filter in APP CODE     │ ← enforced here
  └───────────────────────────────┬───────────────────────────┘
                                  │
  ┌─ Postgres (agents schema) ────▼───────────────────────────┐
  │  every table: app_id text not null default 'laptop'       │
  │  NO Row-Level Security policy  ── the DB does NOT enforce  │ ← the gap
  │  tenant isolation; app code does                          │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: the question is "what stops tenant A from reading tenant B's rows?"
Right now the answer is "the application remembers to put `where app_id = $` on
every query" — not the database. On a single-device tool with one tenant
(`'laptop'`) that's a non-issue. The moment there's a second real tenant, that
app-code discipline becomes a trust boundary, and the missing RLS becomes a
security gap. That's why this is a *data-modeling shape* here and a
*security decision* in **study-security**.

---

## The structure pass

```
  One axis: "what enforces tenant isolation?"

  ┌─ schema (the shape) ─────────────────────────────────────┐
  │  app_id text not null default 'laptop'  ── on ALL 5 tables│  present,
  └─────────────────────────┬────────────────────────────────┘  indexed
                            │  seam: enforcement is NOT in the DB
  ┌─ app code (the guard) ──▼────────────────────────────────┐
  │  where app_id = $2  ── PgVectorStore.search (:73)         │  app code
  │  insert ... app_id = $  ── every write                    │  remembers
  └─────────────────────────┬────────────────────────────────┘
                            │  seam: trust — is app_id authenticated?
  ┌─ source of app_id ──────▼────────────────────────────────┐
  │  AGENT_APP_ID env var, default 'laptop'  ── NOT derived   │  NOT
  │  from any token / auth                                    │  token-derived
  └──────────────────────────────────────────────────────────┘
```

The axis is **what enforces tenant isolation**, and it has *two* seams where the
answer is weaker than you'd assume. First seam: enforcement lives in app code,
not the database (no RLS). Second seam: `app_id` itself isn't derived from an
authenticated token — it's a config value. Both flips are fine for one local
tenant and both are load-bearing the instant the tool goes multi-tenant. Naming
them is the point.

---

## How it works

### Move 1 — the mental model

Think of a `WHERE user_id = currentUser.id` you put on every query in a typical
app. Multi-tenancy by discriminator column is that, one level up: a `where
app_id = $` on every query, where `app_id` names the *tenant* (the app
instance), not the user. The shape is dead simple — one column, one filter. The
hard part isn't the shape; it's *guaranteeing* the filter is never forgotten.
RLS is the database feature that makes the filter automatic and unforgettable;
without it, "never forget the filter" is a code-review discipline.

```
  Discriminator-column tenancy — the shape

  one set of tables, a column tags the owner:

  chunks                                  every query:
  ┌──────────────┬─────────┐               where app_id = 'laptop'
  │ id           │ app_id  │                        │
  │ me.md#0      │ laptop  │ ◄── returned ──────────┘
  │ me.md#1      │ laptop  │ ◄── returned
  │ (hypothetical other)   │
  │ x#0          │ acme    │ ✗ filtered out (IF the filter is present)
  └──────────────┴─────────┘
                              with RLS: DB guarantees the filter
                              without RLS (here): app code must add it
```

### Move 2 — the walkthrough

**The column is on every table, with a default.** Each of the five tables
declares `app_id text not null default 'laptop'`
(`sql/001_agents_schema.sql:6,19,34,54` and the messages table inherits the
tenant via its conversation). `not null` means a row can't escape having a
tenant; the `'laptop'` default means single-device writes don't have to specify
it. That's the shape done correctly — no row is untenanted.

**Reads filter on it — in app code.** The vector search puts the filter in the
SQL itself:

```ts
// pg-vector-store.ts:67-78
async search(vector: number[], k: number): Promise<Hit[]> {
  this.assertDim(vector);
  const { rows } = await this.pool.query(
    `select id, content, chunk_index, document_id, meta,
            1 - (embedding <=> $1::vector) as score
     from agents.chunks
     where app_id = $2                       // ← the tenant filter, in APP code
     order by embedding <=> $1::vector
     limit $3`,
    [toVectorLiteral(vector), this.appId, k],   // this.appId set from config
  );
```

`this.appId` comes from the store's constructor, defaulting to `'laptop'`
(`pg-vector-store.ts:27`), which traces back to `AGENT_APP_ID` via config. The
filter is correct — but it's correct *because the developer wrote it here*, not
because the database insists on it.

**Writes stamp it — also in app code.** The upsert passes `this.appId` into
every chunk row (`pg-vector-store.ts:55`), `indexDocumentRow` passes `appId`
into the documents row (`runtime.ts:11-16`), and `startConversation` stamps it
on the conversation (`supabase-trace-sink.ts:4-7`). Every write path threads the
same value. The discipline is consistent — which is exactly what makes the
*absence* of RLS survivable so far: the app never forgets the filter, because
there's one code path per table.

**There's a supporting index — the shape is queryable.** `chunks_app_id`
(`001:30`) backs the `where app_id = $` filter so the tenant predicate isn't a
scan. Indexing the discriminator column is the right call for any
shared-table-tenant scheme; it's done here. (The HNSW index is still global, see
`01-vector-column-and-ann-index.md` — the `app_id` index and the HNSW index are
separate, which is why the multi-tenant ANN concern is named there.)

**The boundary condition — two things the database does NOT do.** First: there
is **no RLS policy**. Postgres has no rule that says "a connection scoped to
tenant X can only see tenant X's rows." If a query forgot `where app_id = $`, it
would return *every* tenant's rows and nothing would stop it. Second: `app_id`
is **not token-derived** — it's a config value (`AGENT_APP_ID`, default
`'laptop'`), not a claim extracted from an authenticated session. So even with
RLS, the tenant identity here is asserted by config, not proven by auth. Both
are fine for one local user; both are the load-bearing gaps the moment a second
tenant or a network boundary appears.

```
  What the DB enforces vs what it doesn't — be honest

  enforced by DB:     app_id NOT NULL · default 'laptop' · indexed
  NOT enforced by DB: tenant isolation (no RLS)
                      tenant authenticity (app_id not token-derived)
  → today: one tenant, app code disciplined → safe
  → multi-tenant: these two gaps become a security boundary
```

### Move 2.5 — current state vs future state

This pattern is built-but-half-active: the shape ships, the enforcement is
gated on ever needing a second tenant.

```
  Phase A (now)                    Phase B (multi-tenant, not built)
  ───────────────────────────      ─────────────────────────────────
  app_id column, NOT NULL,         + RLS policy: USING (app_id =
   default 'laptop'                   current_setting('app.tenant'))
  app code adds where app_id=$     + app_id DERIVED from auth token,
   on every query                     not config
  one tenant → gaps are dormant    + connection sets app.tenant per
  app_id from AGENT_APP_ID env        request
                                   = DB guarantees isolation; filter
                                     can't be forgotten

  what does NOT have to change: the column, the index, the table
  shapes. Phase B adds policies + an auth-to-app_id mapping. The
  schema shape was forward-compatible from day one.
```

The takeaway is the comforting one: the data-modeling shape doesn't change to go
multi-tenant. You add RLS policies and an auth→`app_id` mapping. The column
being on every table from the start is what makes that a bolt-on rather than a
migration of every row.

### Move 3 — the principle

A discriminator column is the *shape* of multi-tenancy; RLS is its
*enforcement*; token-derived tenant identity is its *trust*. Shipping the shape
without the enforcement is a legitimate phase decision when there's one
tenant — but it's only honest if you name that the database isn't guarding
isolation yet and that the tenant id is asserted, not authenticated. The schema
is forward-compatible; the security posture is "not yet exercised." Both
statements are true at once, and saying both is the difference between a
deliberate phase and a latent vulnerability.

---

## Primary diagram

```
  app_id tenant column — shape present, guard pending

  ┌─ config ──────────────────────────────────────────────────┐
  │  AGENT_APP_ID = 'laptop'   ── NOT token-derived (trust gap) │
  └───────────────────────────────┬────────────────────────────┘
                                  │  this.appId
  ┌─ app code (the only guard today) ─▼─────────────────────────┐
  │  reads:  where app_id = $2     (pg-vector-store.ts:73)      │
  │  writes: insert ... app_id = $ (every write path)           │
  └───────────────────────────────┬────────────────────────────┘
                                  │
  ┌─ agents schema ───────────────▼────────────────────────────┐
  │  documents · chunks · conversations · messages · profiles   │
  │    each: app_id text not null default 'laptop'              │
  │    chunks_app_id index (001:30)                             │
  │  ✗ NO Row-Level Security  ── DB does not enforce isolation  │
  └─────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Shared-table-with-discriminator is one of three classic multi-tenancy shapes
(the others: schema-per-tenant, database-per-tenant). It scales the cheapest
operationally (one schema to migrate) and isolates the weakest (one bug leaks
across tenants) — which is exactly why Postgres RLS exists: to put the isolation
back into the database so an app-code mistake can't leak rows. Supabase leans
hard on RLS for this reason. This repo runs the discriminator shape *without*
RLS because it's single-device — the cheapest shape, the deferred guard, an
honest phase.

The full trust-boundary treatment — what an attacker could do, why a
config-supplied `app_id` isn't an auth claim — is **study-security**. Here the
lesson is the *shape*: the column is right, indexed, and forward-compatible; the
enforcement is a named gap, not an oversight.

---

## Interview defense

**Q: Every table has `app_id` but there's no RLS. Is that a bug?**
No — it's a phase decision, and I'd say so plainly. The discriminator-column
shape is shipped: `app_id not null default 'laptop'` on all five tables, indexed
on `chunks`. The enforcement (RLS) isn't, because there's one tenant on a
single device — app code adds `where app_id = $` on every query consistently
(`pg-vector-store.ts:73`). The honest caveat: the database isn't guaranteeing
isolation, and `app_id` is config-supplied, not token-derived. With a second
tenant those two become a real boundary, and the fix is RLS plus an auth→`app_id`
mapping — a bolt-on, because the column shape was forward-compatible from day
one.

```
  Q: app_id with no RLS — bug or phase?
  shipped:   the SHAPE (column, NOT NULL, indexed)
  deferred:  the GUARD (RLS) + the TRUST (token-derived id)
  safe now:  one tenant, app code disciplined
  the tell:  schema doesn't change for Phase B — only policies + auth map
```

**Q: What's the most surprising risk people miss here?**
Not the missing RLS — that's visible. It's that `app_id` is **not token-derived**
(`AGENT_APP_ID` config). Even if you added RLS tomorrow keyed on `app_id`, the
tenant identity would still be *asserted by config*, not *proven by auth* — so
the policy would enforce a tenant boundary that anyone who can set an env var
can choose. The trust gap is upstream of the enforcement gap. That ordering is
the load-bearing insight.

---

## See also

- `03-soft-link-no-fk.md` — the sibling "shape present, enforcement dropped" call
- `01-vector-column-and-ann-index.md` — why the HNSW index is global, not per-tenant
- `06-trajectory-tables.md` — `app_id` on conversations
- `audit.md` §7 + "not yet exercised" — the RLS gap, marked honestly
- **study-security** — `app_id` as a trust boundary, the full security treatment
