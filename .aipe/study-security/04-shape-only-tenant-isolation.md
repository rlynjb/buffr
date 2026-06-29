# Shape-only tenant isolation

**Industry name:** multi-tenant row isolation via a tenant discriminator —
implemented as *shape only*, without row-level security (RLS). *Industry standard*
(pattern), *deliberately deferred* (enforcement). *Project-specific* gap framing.

## Zoom out, then zoom in

Every table in the `agents` schema carries an `app_id` column. It looks like
multi-tenant isolation — the column you'd key row-level security on. The question
this pattern answers honestly: is that column a *security boundary*, or just a
*shape* waiting to become one? Here's where it lives.

```
  Zoom out — where the tenant discriminator sits

  ┌─ Service layer ──────────────────────────────────────────┐
  │  loadConfig: appId = env.AGENT_APP_ID || 'laptop'         │
  │  (src/config.ts:13)  ← from ENV, not from a token         │
  └───────────────────────────────┬──────────────────────────┘
                                  │  passed into every query as a value
  ┌─ Storage layer ───────────────▼──────────────────────────┐
  │  ★ app_id on every table ★  (sql/001_agents_schema.sql)   │ ← we are here
  │  queries filter `where app_id = $2` (src/pg-vector-store) │
  │  but NO row-level security policy enforces it             │
  └───────────────────────────────────────────────────────────┘
```

The pattern (a tenant discriminator) is how every multi-tenant system separates one
customer's rows from another's: a column on each row says whose data it is, and the
database refuses to return rows that aren't yours. buffr has the *column* and the
*filter* — but not the *refusal*. The `app_id` is set from an environment variable
(default `'laptop'`), not derived from any authenticated identity, and no RLS policy
makes the database enforce it. That's not a bug at single-device scale; it's the
shape laid down ahead of the enforcement it'll need later.

## The structure pass

**Layers:** the identity source (where `app_id` comes from) → the query filter
(where it's applied) → the database (whether it *enforces*).

**The axis to trace: trust.** "Could a caller read another tenant's rows?" Hold it
down the layers and watch where a real boundary *would* be — and isn't.

```
  One axis — "could a caller cross tenants?" — traced down

  ┌─ identity ──────────┐   app_id = env var, default 'laptop'
  │  env, not token     │   → trust: not tied to WHO you are
  └──────────┬──────────┘
             │  seam: where app_id = $2 (a value, app-supplied)
  ┌─ filter ─▼──────────┐  query asks for its own app_id...
  │  app-level WHERE    │  → but the APP chooses the value; nothing
  └──────────┬──────────┘    forces it to ask for only its own
             │  seam where RLS WOULD be — and ISN'T
  ┌─ db ─────▼──────────┐  Postgres returns whatever app_id is asked for
  │  no RLS policy      │  → the boundary that should flip trust... doesn't
  └─────────────────────┘
```

In a system with RLS, trust flips at the database: even a compromised app query
can't read another tenant's rows because the policy rewrites every query to add the
tenant filter. Here that seam is *empty* — the filter is voluntary, app-side, and
keyed on an env var. The boundary is drawn (the column exists) but not enforced.

## How it works

### Move 1 — the mental model

You know how a `WHERE user_id = ?` in your app code keeps you from showing the wrong
user's todos — but if you forget the clause on one query, you leak everything?
RLS is the database doing that `WHERE` for you, on *every* query, automatically, so
forgetting is impossible. buffr has the app-side `WHERE` but not the database-side
guarantee. The discriminator is present; the enforcement is the gap.

```
  The pattern — discriminator with vs without enforcement

  WITH RLS (the target):
    request → app query (any) → DB rewrites: ... AND app_id = <session's> → safe
                                  ▲ enforced by the database, not the app

  buffr today (shape only):
    config → app query: ... where app_id = $2  ($2 = env 'laptop') → returns those rows
                                  ▲ enforced by the APP remembering to ask correctly
                                    and by there being only ONE tenant anyway
```

The kernel of *real* isolation: **identity from an authenticated token + a database
policy that filters every query automatically.** buffr has neither yet — it has a
column and an env-sourced value. What makes that safe *today* is the absence of a
second tenant, not the presence of a control.

### Move 2 — the walkthrough

**Where `app_id` comes from — an env var, not an identity.**

```ts
// src/config.ts:9-15
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    ...
    appId: env.AGENT_APP_ID || 'laptop',     // ← from ENV, default 'laptop'
    ...
  };
}
```

This is the load-bearing line for the "deferred" framing. `app_id` is whatever the
environment says, defaulting to `'laptop'`. It is **not** derived from a logged-in
user, a JWT claim, or any authenticated identity — there is no auth layer (see
`audit.md` lens 2). So `app_id` can't be a trust boundary: a boundary keyed on a
value the caller sets isn't a boundary, it's a preference.

**Where it's applied — every table has the column, every query filters on it.**

```sql
-- sql/001_agents_schema.sql — the column, repeated on each table
app_id text not null default 'laptop',     -- documents:6, chunks:19, conversations:34,
                                           -- messages (via conversation), profiles:54
create index if not exists chunks_app_id on agents.chunks (app_id);   -- :30
```

```ts
// src/pg-vector-store.ts:70-77 — the voluntary filter
`select ... from agents.chunks
 where app_id = $2                          // ← app-side scope, not DB-enforced
 order by embedding <=> $1::vector limit $3`,
[toVectorLiteral(vector), this.appId, k],
```

The column is indexed and the filter is consistently applied — `loadProfile`
(`src/profile.ts:5`), `upsert` (`src/pg-vector-store.ts:48,55`), `startConversation`
(`src/supabase-trace-sink.ts:5-6`) all carry `app_id`. The *shape* is complete. What's
missing is in the database: there is **no** `alter table ... enable row level
security` and **no** `create policy` anywhere in `sql/001_agents_schema.sql`. Nothing
stops a query from passing a different `app_id` and reading those rows.

**The widening factor — memory and documents share one store.**

```ts
// src/session.ts:53 — memory rides the same vector store as documents
const memory = createConversationMemory({ embedder, store });   // ← same `store`
```

Because conversation memory lives in `agents.chunks` alongside documents (tagged
`meta.kind='memory'`), a future second tenant without RLS could `search` across the
boundary and surface another tenant's *remembered conversations*, not just their
documents. Today there's one tenant, so nothing crosses. But it raises the stakes of
adding RLS later — the shared store means the discriminator has to hold for memory
rows too.

```
  The gap, drawn — what exists vs what enforces

  ┌─ EXISTS (shape) ─────────────┬─ MISSING (enforcement) ──────┐
  │ app_id column, every table   │ RLS policy on any table      │
  │ app_id index on chunks       │ identity from a token        │
  │ `where app_id = $2` filters  │ DB-side automatic filtering  │
  │ default 'laptop'             │ per-request tenant binding   │
  └──────────────────────────────┴──────────────────────────────┘
  safe today ONLY because: one tenant, one operator, one device
```

### Move 2.5 — current state vs future state

This is the cleanest current-vs-future split in the whole guide, because the column
was deliberately laid down *now* for the enforcement that comes *later*.

```
  Phase A (now)                  │  Phase B (phone/edge, multi-tenant)
  ───────────────────────────────┼──────────────────────────────────
  app_id from env ('laptop')     │  app_id (or user_id) from auth token
  filter is voluntary, app-side  │  RLS rewrites every query at the DB
  one tenant → no boundary needed│  many tenants → boundary is mandatory
  shared doc+memory store fine   │  RLS must cover memory rows too
  full-privilege DATABASE_URL    │  scoped, RLS-bound DB role
```

**What doesn't have to change:** the schema. The `app_id` column is already on every
table, already indexed, already threaded through every query. Turning on isolation is
*additive* — `enable row level security` + a `create policy` keyed on the session's
tenant, plus deriving that tenant from a token instead of an env var. The hard part
(retrofitting a discriminator onto an existing schema) is already done. That's the
payoff of laying the shape down early: the migration is enablement, not surgery.

**What must change:** three things, in order — (1) an auth layer so there's a real
identity (lens 2), (2) `app_id`/`user_id` derived from that identity's token, not the
env, (3) RLS policies so the database enforces it instead of trusting the app. And
the `DATABASE_URL` superuser string becomes an RLS-bound role (`audit.md` lens 4),
because RLS does nothing if the connection bypasses it as a superuser.

### Move 3 — the principle

A tenant discriminator is only a security control when two things are true: the
tenant value comes from authenticated identity, and the database — not the
application — enforces the filter. buffr has the *column* without either, which is
exactly right for a single-device phase: you lay the shape down early so the
enforcement is a cheap additive migration later, and you don't pay for RLS complexity
while there's only one tenant. The discipline is knowing the difference between
"isolated" and "shaped for isolation," and never confusing the second for the first.
The column says "whose data" — it doesn't yet say "and you can't have anyone else's."

## Primary diagram

```
  Shape-only tenant isolation — full picture

  ┌─ Service (src/config.ts) ────────────────────────────────┐
  │  appId = env.AGENT_APP_ID || 'laptop'   (NOT from a token)│
  └───────────────────────────────┬──────────────────────────┘
                                  │  app_id passed as a query value
  ┌─ Storage (sql/001 + pg-vector-store) ─▼──────────────────┐
  │  every table: app_id column (+ index on chunks)          │
  │  every query: where app_id = $2     ← VOLUNTARY, app-side │
  │  ┌─────────────────────────────────────────────────────┐ │
  │  │ MISSING: enable row level security + create policy  │ │ ← the gap
  │  │ MISSING: identity-derived tenant value              │ │
  │  └─────────────────────────────────────────────────────┘ │
  │  docs + memory share agents.chunks → one boundary to hold│
  └───────────────────────────────────────────────────────────┘
  safe today: one tenant. Phase B: token → RLS, additive migration.
```

## Elaborate

Multi-tenant isolation has two camps: separate-database-per-tenant (strong, costly)
and shared-database-with-a-discriminator (cheap, needs RLS to be safe). buffr is set
up for the second — the cheap one — which is the right default for a personal tool
that *might* grow into a multi-device system. Postgres RLS is the mechanism that
makes the discriminator trustworthy: it rewrites every query to append the tenant
predicate, so even a buggy or compromised application query can't read across
tenants. The reason buffr can defer it without guilt is the single-tenant reality:
RLS defends against tenant B reading tenant A, and there is no tenant B yet. The
schema already paying the `app_id` tax on every table is the tell that this was
planned, not forgotten — the gap is scheduled, not accidental.

## Interview defense

**Q: You put `app_id` on every table but no RLS. Isn't that fake isolation?**
It's *shape without enforcement*, and I'd call it that plainly. `app_id` comes from
an env var, not a token, and no RLS policy enforces the filter — so today it's not a
security boundary, it's a column. That's correct for single-device: there's one
tenant, so there's nothing to isolate *from*. The value is that the expensive part —
retrofitting a discriminator onto every table — is already done, so turning on real
isolation later is an additive migration (`enable rls` + a policy + token-derived
tenant), not a schema rewrite.

```
  discriminator becomes a boundary only when BOTH hold:
    tenant value ← authenticated token   (not env)
    filter enforced ← database RLS        (not app code)
  buffr has the column; both enforcement halves are Phase B
```

**Q: What's the trap when you finally add RLS?**
Two: the shared doc+memory store means the policy has to cover *memory* rows too, not
just documents (`session.ts:53`) — and the `DATABASE_URL` superuser role bypasses
RLS entirely, so it has to become an RLS-bound role at the same time, or the policy
does nothing.

**Anchor:** "The column says whose data — it doesn't yet say you can't have anyone
else's. That's RLS plus a token, and both are Phase B."

## See also

- `audit.md` lens 2 (auth) and lens 4 (the superuser `DATABASE_URL`) — the two
  controls RLS depends on.
- `01-parameterized-sql-boundary.md` — why `app_id = $2` is bound safely yet still
  not a security boundary (injection vs authorization are orthogonal).
- `03-indirect-prompt-injection-surface.md` — the shared doc+memory store this gap
  also touches.
- `.aipe/study-data-modeling/` — the `agents` schema and `app_id` column shape.
- `.aipe/study-system-design/` — the local-first / future-mirror architecture.
