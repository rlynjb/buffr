# Shape-Only Tenant Isolation

*Multi-tenancy without enforcement / app-level scoping vs row-level security — Project-specific.*

## Zoom out, then zoom in

Every table has an `app_id`. Every query filters on it. And yet there's no
real isolation. Here's where the gap sits.

```
  Zoom out — the tenant column is everywhere, the enforcement is nowhere

  ┌─ Identity source ───────────────────────────────────────────┐
  │  AGENT_APP_ID env var (default 'laptop')  ← NOT a token      │  ★ the gap
  └─────────────────────────┬───────────────────────────────────┘
                            │  config.appId — a constant
  ┌─ App layer ────────────▼────────────────────────────────────┐
  │  PgVectorStore(appId) · loadProfile(appId) · ...             │
  │  every query: where app_id = $2                              │
  └─────────────────────────┬───────────────────────────────────┘
                            │  full-privilege DATABASE_URL
  ┌─ Postgres ─────────────▼────────────────────────────────────┐
  │  agents.* — app_id column present, NO RLS policies           │ ← shape only
  │  any connection can read/write any app_id's rows             │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: tenant isolation answers "can tenant A read tenant B's rows?" There
are two places to enforce a *no*: in the **application** (every query
remembers to add `where app_id = $me`) and in the **database** (RLS policies
the DB enforces no matter what query you send). buffr has the *column* and
the *application filter* but neither the *identity* nor the *database
enforcement*. The isolation is shaped — it looks multi-tenant — but it's not
*enforced*, and the `app_id` it filters on isn't tied to who you are. That's
the finding.

## Structure pass

**Layers.** Three: where identity *comes from* (env var), where it's
*applied* (the app-layer `where app_id =` filters), and where it could be
*enforced* (the database — RLS).

**Axis — trust.** Trace "what stops a cross-tenant read?" down the layers:

```
  One axis (trust) down the isolation layers

  ┌─ identity layer ──────────────┐
  │  app_id = env default 'laptop'│  → not derived from any verified caller
  └────────────────────────────────┘   (nothing to forge against — yet)
  ┌─ application layer ───────────┐
  │  where app_id = $2 in queries │  → honored only if the dev remembers it
  └────────────────────────────────┘   (one forgotten filter = a leak)
  ┌─ database layer ──────────────┐
  │  RLS policies                 │  → ABSENT. DB enforces nothing.
  └────────────────────────────────┘   (full-priv connection sees all rows)

  the trust answer is "nothing, structurally" — every layer is advisory
```

**Seam.** The load-bearing seam is the database connection. On the laptop,
one operator holds a full-privilege `DATABASE_URL`, so the seam carries no
trust decision — there's only one tenant. The seam *becomes* load-bearing
the instant a second tenant shares the database: then "the app remembered to
filter" is the only thing between them, and RLS is the missing backstop.

## How it works

### Move 1 — the mental model

You know the difference between client-side and server-side form validation.
Client-side validation is advisory — a polite UX nudge the user can bypass
with curl. Server-side validation is the real boundary. App-level `where
app_id =` filters are **client-side validation for your rows**: helpful,
honored when present, and bypassable by anything that talks to the database
directly. RLS is the server-side check — the database refuses to return the
row no matter what query arrives.

```
  Two places to enforce isolation — buffr has only the advisory one

  request to read rows
        │
        ▼
  ┌─ app filter ─────────────┐   "where app_id = $me"
  │  PRESENT but advisory     │   ← skipped if a query forgets it,
  └──────────┬───────────────┘     or if you connect with psql directly
             │
             ▼
  ┌─ RLS policy ─────────────┐   "policy: app_id = current_setting(...)"
  │  ABSENT                   │   ← the DB would refuse the row here
  └──────────┬───────────────┘     but there is no policy, so it doesn't
             │
             ▼
       rows returned — for ANY app_id if the filter was skipped
```

The strategy in one sentence: **isolation that lives only in application
code is one forgotten `WHERE` away from a leak; RLS moves the check into the
database where forgetting is impossible.**

### Move 2 — the walkthrough

**Part 1 — the identity that isn't.** `app_id` should answer "who is this
request acting as?" In buffr it's `AGENT_APP_ID` from the environment
(default `'laptop'`), read once at startup. It's a *configuration constant*,
not a *claim about the caller*. Remove the env var and you don't get "access
denied" — you get the default `'laptop'`. There's no caller to authenticate
because there's no request; the CLI *is* the operator. The part that breaks
when you go multi-tenant: there's nothing to derive a *different* `app_id`
from, so two tenants on one DB would both be `'laptop'` unless something
upstream sets the var — and an env var is not an authenticated identity.

```
  Where app_id comes from — a constant, not a claim

  process.env.AGENT_APP_ID   ──►  config.appId = 'laptop'  ──► every query
        │                              │
        │                              └─ same value for the whole process
        └─ set by the operator, not proven by a token

  contrast (the target): app_id = verifiedToken.claims.tenant
        └─ derived per-request from a signature you checked
```

**Part 2 — the app-level filter (present, advisory).** Every read scopes by
`app_id`: the vector search, the profile load, the trace writes. This is the
*right shape* — it's exactly what you'd keep when RLS arrives. But it's
advisory: it works because each query author wrote the filter, and one query
that forgets it returns every tenant's rows. The part that breaks: there's
no compiler or database check that a new query *included* the filter. It's a
discipline, not a guarantee.

```
  The filter is honored only because every query remembers it

  search:   where app_id = $2     ← present (pg-vector-store.ts:74)
  profile:  where app_id = $1     ← present (profile.ts:6)
  insert:   app_id passed as $3   ← present (pg-vector-store.ts:55)
       │
       └─ add a 6th query tomorrow, forget the filter once,
          and on a shared DB it reads across tenants. Nothing stops you.
```

**Part 3 — the absent backstop (RLS).** The database has no row-level
security policies — `sql/001_agents_schema.sql` creates tables, indexes, and
an FK cleanup, but zero `create policy` / `alter table ... enable row level
security`. So the connection sees every row regardless of `app_id`. Combined
with a full-privilege `DATABASE_URL`, the database enforces nothing. The part
that breaks when missing: the *defense-in-depth* layer. RLS is what makes the
forgotten-`WHERE` in Part 2 a non-event — the DB refuses the cross-tenant row
even if the app asks for it.

### Move 2.5 — current state vs future state

This is built-but-deferred on purpose. The plan (`agent-layer-plan.md`)
names "a multi-tenant centralized service **with RLS**" as a portfolio goal
— the `app_id` column is the *seam left in place now* so the migration is
additive later.

```
  Phase A (now)                      Phase B (centralized / edge)
  ──────────────────────────────     ──────────────────────────────────
  one operator, one laptop           many tenants, shared Supabase
  app_id = env default               app_id = verified token claim
  app-level filter only              app-level filter + RLS policies
  full-priv DATABASE_URL on device   scoped role, or server holds the cred
                                      + client holds a short-lived token

  what does NOT change: the schema (app_id is already on every table)
  and the query shape (where app_id = $N already exists). Phase B adds
  enforcement under the shape that's already there.
```

The cost of deferring: today, none — one tenant can't leak to itself. The
cost of the migration: write RLS policies keyed on a session variable, set
that variable per-connection from the token, and swap the full-priv
credential for a scoped one. The schema and queries are already shaped for
it. That's the payoff of putting `app_id` everywhere now.

### Move 3 — the principle

The principle: **isolation enforced only in application code is advisory;
real isolation needs a check the caller can't skip.** The database is the
right place for that check because every path to the data goes through it —
RLS can't be forgotten by a new query the way an app-level `WHERE` can. The
deeper lesson is about *where a control lives*: a control is only as strong
as the narrowest place every access must pass through, and for row access
that's the database, not the application.

## Primary diagram

The full picture: the column and filter exist at every layer, the
enforcement exists at none.

```
  buffr-laptop — tenant isolation, shape vs enforcement

  ┌─ identity ──────────────────────────────────────────────────┐
  │  AGENT_APP_ID env → config.appId 'laptop'                    │
  │  (a constant, not a verified claim)              SHAPE ✓     │
  └─────────────────────────┬───────────────────────────────────┘
                            │
  ┌─ application ──────────▼────────────────────────────────────┐
  │  where app_id = $N  in search / profile / trace queries      │
  │  (honored, but advisory — one forgotten filter leaks) SHAPE ✓│
  └─────────────────────────┬───────────────────────────────────┘
                            │  full-privilege DATABASE_URL
  ┌─ database ─────────────▼────────────────────────────────────┐
  │  agents.* tables — app_id column present                     │
  │  NO RLS, NO policies, NO scoped role          ENFORCE ✗     │
  └──────────────────────────────────────────────────────────────┘

  shape present at every layer; enforcement at none.
  fine for one tenant; a leak the day there are two.
```

## Implementation in codebase

**Use cases.** The `app_id` scoping is reached for on every read and write:
filtering search results to the current app, loading the right profile,
tagging trajectory rows. The intent is multi-tenant; the enforcement is
single-tenant.

**Code side by side.**

```
  src/config.ts  (lines 9–16)

  export function loadConfig(env: NodeJS.ProcessEnv): Config {
    return {
      ...
      appId: env.AGENT_APP_ID || 'laptop',   ← identity is an env default,
      ...                                       not derived from a token
    };
  }
        │
        └─ this is the root of the finding: app_id never comes from an
           authenticated caller. Falls back to 'laptop' when unset — a
           default, not a denial.
```

```
  src/pg-vector-store.ts  (search, line 74)        src/profile.ts (line 6)

  where app_id = $2                                where app_id = $1
        │
        └─ the app-level filter — correct shape, present on every read.
           But it's the ONLY thing scoping rows: there's no RLS behind it.
           A query that omits this line on a shared DB reads all tenants.
```

```
  sql/001_agents_schema.sql  (the whole file)

  create table if not exists agents.chunks (
    ...
    app_id text not null default 'laptop',   ← column present on every table
    ...
  );
  create index ... chunks_app_id on agents.chunks (app_id);  ← indexed for the filter
        │
        └─ what's NOT here: no `alter table ... enable row level security`,
           no `create policy`. The schema is shaped for tenants but enforces
           nothing. The default 'laptop' means a row with no explicit app_id
           silently joins the default tenant.
```

## Elaborate

This is the standard multi-tenant maturity curve, caught mid-climb. The
progression: (1) a tenant column, (2) app-level filters on that column, (3)
the column derived from a verified identity, (4) RLS so the database enforces
it regardless of the app. buffr is solidly at (2). AdvntrCue — your RAG web
app — faces the same question the moment it has real users; the pattern
transfers directly.

The reason RLS is the gold standard isn't that app-level filters are *wrong*
— they're the right shape and you keep them. It's that they're a *discipline*
that scales badly: every new query, every new developer, every refactor is
another chance to forget the `WHERE`. RLS converts "everyone must remember"
into "the database guarantees," and a guarantee beats a discipline once more
than one person touches the code. Postgres RLS keys policies on a session
variable (`current_setting('app.current_tenant')`), which you set per
connection from the verified token — so the identity gap (Part 1) and the
enforcement gap (Part 3) get closed by the same move.

## Interview defense

**Q: You have `app_id` on every table and `where app_id =` on every query.
Isn't that multi-tenant isolation?**

It's the *shape* of it, not the enforcement. Two things are missing. First,
`app_id` is an env default (`config.ts:12`), not derived from a verified
identity — so it doesn't actually answer "who is this." Second, there's no
RLS (`sql/001` has no policies), so a full-privilege connection sees every
tenant's rows regardless of the filter.

```
  what's there        what's missing
  ───────────────     ──────────────────────────────
  app_id column   →   identity binding (token → app_id)
  app filter      →   RLS (DB-enforced, can't be forgotten)
```

The anchor: **app-level filters are client-side validation for rows —
advisory, one forgotten WHERE from a leak. RLS is the server-side check.**
On a single-device laptop that's fine because there's one tenant; I left the
column in place precisely so RLS is an additive migration, not a rewrite.

**Q: Why is it acceptable to ship without RLS right now?**

Because there's exactly one tenant and one operator who already owns the
database and the credential. There's no second party to isolate *from*. The
control would defend a capability — cross-tenant row isolation — that no
current actor can exercise. The honest engineering call is to put the seam in
now (the `app_id` column, the filters) and add enforcement when a second
tenant makes it load-bearing. Shipping RLS for one tenant is defending
against a threat that doesn't exist yet — and the plan names exactly when it
will.

## Validate

1. **Reconstruct.** Draw the three layers (identity / application /
   database) and mark which has enforcement. From memory, where does `app_id`
   come from, and why isn't that an identity?
2. **Explain.** Why does a forgotten `where app_id = $N` in a new query leak
   across tenants today but would *not* if RLS were enabled?
3. **Apply.** Sketch the Phase B migration: what does `app_id` get derived
   from, what does an RLS policy on `agents.chunks` look like, and what
   replaces the full-privilege `DATABASE_URL`?
4. **Defend.** Argue against a teammate who says "RLS is overkill, we'll just
   be careful to always add the filter." Name the specific failure their
   approach can't prevent.

## See also

- `01-parameterized-sql-boundary.md` — the orthogonal control. SQL is
  injection-proof; that's about query *structure*. This file is about the
  *value* `app_id` and whether it isolates. A query can be perfectly
  parameterized and still leak every tenant.
- `study-data-modeling` — the `app_id` column design, the `default 'laptop'`
  choice, and whether the column is *modeled* well (separate from whether it
  *isolates*).
- `study-system-design` — the centralized-Supabase boundary and the
  phone/edge phase that turns this gap load-bearing.
