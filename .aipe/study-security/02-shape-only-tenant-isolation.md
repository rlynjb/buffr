# Shape-only tenant isolation

**Industry name(s):** multi-tenancy by discriminator column /
application-enforced tenancy (vs. row-level security). **Type:**
Project-specific (a deliberate pre-shaping of a future control).

## Zoom out, then zoom in

Every table in buffr carries an `app_id` column. That column is the
*shape* of multi-tenant isolation — the place a tenant boundary will
live. But right now nothing *enforces* it: there's no RLS, the value
isn't derived from any identity, it's a constant `'laptop'` read from
an env default. The isolation is drawn but not wired.

```
  Zoom out — where tenancy lives (and doesn't)

  ┌─ Service layer (app process) ───────────────────────────────────┐
  │  config.appId = env.AGENT_APP_ID || 'laptop'   ◄ a constant     │
  │  every query carries  where app_id = $2  /  insert app_id = $3   │
  └───────────────────────────┬─────────────────────────────────────┘
                              │  the app PROMISES to pass app_id
  ┌─ Storage layer (Postgres) ▼──────────────────────────────────────┐
  │  documents.app_id  chunks.app_id  conversations.app_id  ...       │
  │  ★ NO RLS — the DB does NOT check who's asking ★                  │ ← the gap
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is a **discriminator column** — one field that
tags every row with which tenant owns it. The question it answers:
"whose row is this?" The thing to understand is the difference between
*shape* and *enforcement*, because buffr has the first and not the
second, on purpose. A senior reading this should leave knowing exactly
what flips when the second one turns on — and that almost no code has
to move.

## The structure pass

**Layers:** two — the app layer that *passes* `app_id`, and the
storage layer that *stores* it. The boundary between them is where
enforcement is missing.

**Axis — trust.** Trace "who guarantees this query only sees my
tenant's rows?":

```
  axis traced = "who enforces the tenant boundary?"

  ┌─ app side ───────────┐  seam: pool.query  ┌─ Postgres ──────────┐
  │ app PASSES app_id=$2 │ ═══════╪══════════► │ stores it, trusts   │
  │ (could pass any!)    │  (does NOT flip)    │ the app's value     │
  └──────────────────────┘                     └─────────────────────┘
       ▲                                              ▲
       └──── trust does NOT flip across this seam ────┘
             → that's the finding: no boundary is enforced here
```

This is the *inverse* of `01`'s diagram. There, trust flipped at the
seam (the SQL boundary did its job). Here, the trust answer is the
*same* on both sides — the app is trusted to pass the right `app_id`
and the DB trusts whatever it's given. A seam where the axis doesn't
flip is a boundary that isn't load-bearing yet. That's the whole
finding.

## How it works

You've shipped this exact shape before — in AdvntrCue, vector and
relational data colocated in one Postgres, queries filtering on a
key. The mechanism here is the same `WHERE` clause; the security
question is *who you trust to set the key.*

```
  The pattern — discriminator column, app-enforced

   write path                      read path
   ┌──────────────────────┐        ┌──────────────────────────┐
   │ insert ... app_id=$3 │        │ select ... where         │
   │   value: 'laptop'    │        │   app_id = $2            │
   │   (from config)      │        │   value: 'laptop'        │
   └──────────────────────┘        └──────────────────────────┘
        │                               │
        ▼  every row tagged             ▼  query filters to tag
   ┌──────────────────────────────────────────────────────────┐
   │  chunks: [row a:'laptop'] [row b:'laptop'] ...            │
   │  ◄ isolation holds ONLY because the app always passes     │
   │     the same constant. Nothing stops it passing another.  │
   └──────────────────────────────────────────────────────────┘
```

### The kernel — three parts, and which one is missing

A real tenant boundary has three load-bearing parts. buffr has two:

1. **The discriminator column** — present. `app_id` on every table
   (`sql/001_agents_schema.sql:6,18,33,42,54`). *Breaks if missing:*
   no way to tag which rows belong to whom.
2. **The filter on every query** — present. `where app_id = $2` on
   reads (`src/pg-vector-store.ts:73`, `src/profile.ts:5`), `app_id`
   on writes (`src/pg-vector-store.ts:48`, `src/runtime.ts:11`,
   `src/supabase-trace-sink.ts:5`). *Breaks if missing:* a query
   returns every tenant's rows.
3. **The enforcement that the value is *yours*** — **missing.** Nothing
   binds `app_id` to a verified identity, and nothing in the DB
   *rejects* a query that asks for someone else's `app_id`. *Breaks
   when this is missing AND there's more than one tenant:* any client
   that can set `AGENT_APP_ID` reads any tenant's data.

Part 3 is the whole difference between "shape" and "enforced." On a
single-user laptop, part 3 is unnecessary — there's one tenant, and
the constant `'laptop'` is always correct.

### Where the value comes from — and why that's the tell

`src/config.ts:11`:

```
  appId: env.AGENT_APP_ID || 'laptop',   ◄ a constant, NOT identity-derived
```

This is the line that proves the isolation is shape-only. A real
tenant id is *extracted from a verified session* — a token claim, a
validated cookie. This one is read from an environment variable with a
hardcoded default. There is no identity in the system to derive it
from (see `audit.md` lens 2 — no auth). So `app_id` is currently a
*label*, not a *credential*.

### The two-phase view — what flips, and what doesn't

This is the payoff, and it's good news: the migration is almost all
DB-side.

```
  Phase A (now)                    Phase B (multi-client)
  ──────────────────────────       ──────────────────────────────
  app_id = 'laptop' (constant)     app_id = token claim (per request)
  app passes the filter            RLS enforces the filter in Postgres
  DB trusts the app                DB checks current_setting / JWT
  one tenant, no auth              N tenants, auth required
  ──────────────────────────       ──────────────────────────────
   columns, filters, queries  ──── UNCHANGED ────►  same SQL works
   what's added: a session sets the tenant; RLS policies reject
                 cross-tenant rows; app_id sourced from identity
```

The columns don't change. The `WHERE app_id = $2` filters don't change
— RLS makes them *redundant but harmless*. What's added is a Postgres
RLS policy (`create policy ... using (app_id = current_setting('app.tenant'))`)
plus a line in the session that sets that tenant from a verified token
instead of an env default. That's the entire jump from shape to
enforcement. The reason buffr put the column in now — when it does
nothing — is so this jump is additive, not a schema rewrite.

### The principle

Pre-shaping a control is a real engineering decision, not an oversight,
*if and only if* you can name the trigger that turns it on and the
work stays small. buffr passes that test: the trigger is a second
client, the work is RLS + token-sourced `app_id`, and no existing query
changes. The anti-pattern would be claiming the `app_id` column *is*
isolation — it isn't, it's the place isolation will go. Calling it
"shape-only" out loud is what keeps it honest.

## Primary diagram

The full picture: shape present, enforcement deferred, trigger named.

```
  Shape-only tenant isolation — buffr-laptop

  ┌─ Identity layer ────────────────────────────────────────────────┐
  │  NONE YET — no auth, no token, no session identity (lens 2)      │
  │  app_id sourced from:  env.AGENT_APP_ID || 'laptop'  ◄ constant  │
  └───────────────────────────┬─────────────────────────────────────┘
                              │  passed as a literal into every query
  ┌─ Service layer ───────────▼──────────────────────────────────────┐
  │  reads:  where app_id = $2     writes: app_id = $3                │
  │  the app PROMISES correctness; nothing verifies it               │
  └───────────────────────────┬──────────────────────────────────────┘
                              │  pool.query (no per-tenant DB check)
  ┌─ Storage layer (Postgres) ▼───────────────────────────────────────┐
  │  app_id column on ALL tables  ── NO RLS ──                         │
  │  ★ enforcement gap: DB trusts the app's app_id value ★            │
  │  Phase B target: RLS policy keyed on a session-set tenant         │
  └────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The discriminator-column pattern is the simplest multi-tenancy model —
cheaper than schema-per-tenant or database-per-tenant, and it's what
most SaaS starts with. Its known failure mode is exactly buffr's
current state shipped to production by accident: the column exists, the
app filters on it, everyone *assumes* that's isolation, and then a
single missing `WHERE app_id` (or a client that sets its own `app_id`)
leaks across tenants. Postgres RLS is the fix the database itself
offers — it moves the filter from "every query must remember" to "the
engine enforces, no query can forget." buffr hasn't reached for it
because with one tenant there's nothing to enforce against. The
discipline is to add RLS *at the same commit* that adds the second
client, not after.

This is the security read of a data-modeling decision: `study-data-modeling`
covers *why* `app_id` is shaped the way it is and what it indexes; this
file covers *whether that shape protects anyone* (today: it's
single-user, so the question is moot; tomorrow it's the first thing to
wire).

## Interview defense

**Q: You put `app_id` on every table but no RLS. Isn't that a
vulnerability?**

Not in the single-device phase — it's a *deferred control*, and I can
name exactly what's deferred. There's one tenant and no auth, so
`app_id` is a constant `'laptop'` and the filter is always correct.
The vulnerability only exists with a second tenant *and* a way to set
`app_id`, neither of which exists yet. I shaped the column now so the
fix later is additive: add an RLS policy and source `app_id` from a
verified token. No existing query changes.

```
  shape (now)  ──add RLS + token-sourced app_id──►  enforced (later)
  columns + filters stay identical; DB starts checking
```

Anchor: *the column is where isolation will live, not isolation
itself — and the migration is DB-side, not a rewrite.*

**Q: What's the one line that proves it's not enforced?**

`appId: env.AGENT_APP_ID || 'laptop'` in `src/config.ts:11`. A real
tenant id comes from a verified identity; this comes from an env
default. That single line is the difference between a label and a
credential.

Anchor: *identity-derived vs env-derived is the whole tell.*

## See also

- `audit.md` — lens 2 (auth, not yet exercised) and lens 4 (the
  full-privilege `DATABASE_URL` that shares this deferral).
- `01-parameterized-sql-boundary.md` — the `where app_id = $2` filter
  is parameterized; here we ask whether the filter is *trusted*.
- `04-least-privilege-tool-scope.md` — the other "control sized to the
  phase" decision in this repo.
- `../study-data-modeling/` — the schema-shape rationale for `app_id`.
- `../study-system-design/` — the local-first / opt-in-mirror
  architecture that makes single-tenant correct today.
