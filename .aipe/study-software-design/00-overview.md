# 00 — Overview: the audit at a glance

The punch list. If you read one file, read this one.

---

## The verdict, first

buffr-laptop is a **small, deliberately-deep codebase**. Eight source
files in `src/`, none over ~95 lines, and the two that carry real weight —
`PgVectorStore` and `createChatSession` — are genuinely deep: small
interfaces over bodies that hide transactions, dimension guards, encoding,
distance math, and a five-object lifecycle. That's the good news, and it's
the dominant story. The design *works*.

The complexity that exists is not sprawl — it's **two specific leaks**, and
one is dead weight you can delete today.

---

## Complexity profile — where the symptoms cluster

```
  Where complexity lives in buffr-laptop

  ┌─ low complexity ────────────────────────────────────────┐
  │  config.ts · db.ts · profile.ts · runtime.ts            │
  │  pure or near-pure, one job each, easy to read          │
  └──────────────────────────────────────────────────────────┘

  ┌─ earned complexity (deep, pays its way) ────────────────┐
  │  pg-vector-store.ts   ★ deepest module                  │
  │  session.ts           ★ deep facade                     │
  │  supabase-trace-sink.ts  (sync/async split)             │
  └──────────────────────────────────────────────────────────┘

  ┌─ unearned complexity (the two leaks) ───────────────────┐
  │  LEAK 1: the schema knob nobody reads (config.ts:13     │
  │          vs `agents.` hardcoded in 5 files)             │
  │  LEAK 2: the meta magic-keys contract (docId/chunkIndex │
  │          /text) known in upsert, search, AND aptkit     │
  └──────────────────────────────────────────────────────────┘
```

---

## The three highest-cost hotspots

Ranked by cost-to-the-reader, worst first.

### 1. The dead `schema` knob — information leakage + a false promise

**Files:** `src/config.ts:13` (computed) vs `src/pg-vector-store.ts:48,73`,
`src/runtime.ts:12`, `src/supabase-trace-sink.ts:6,28`, `src/profile.ts:6`
(consumed as a hardcoded `agents.` literal).

`loadConfig` reads `AGENT_DB_SCHEMA` into `cfg.schema` — and **nothing ever
reads `cfg.schema`**. Every SQL statement hardcodes `agents.` directly. The
schema name is one decision known in six places; the config knob promises
you can change it via env, and that promise is a lie — set `AGENT_DB_SCHEMA=foo`
and every query still hits `agents.`. This is the clearest APOSD red flag in
the repo: *the same knowledge edited in two places* (here, seven), plus
*avoidable config exposed to callers* that does nothing. Cheapest fix in the
repo: delete the field, or make it real. Full walk in `audit.md` §3 and §5.

### 2. The `meta` magic-keys contract — an undocumented interface

**File:** `src/pg-vector-store.ts:44-46` (write side) and `:83` (read side).

`PgVectorStore` reaches into `c.meta.docId`, `c.meta.chunkIndex`, and
`c.meta.text` on the way in, and reconstructs exactly those three keys on the
way out (`:83`). Three string keys are a load-bearing contract between buffr,
aptkit's retrieval pipeline, and the `search_knowledge_base` tool's
citations — and it lives only in `typeof` checks, with no type and no
interface comment naming it. Get a key wrong and retrieval silently returns
empty `text`. This is the deepest part of the deepest module, and its
contract is invisible. Walk in `01-adapter-behind-a-contract.md`.

### 3. `db.ts` — the one genuinely shallow module

**File:** `src/db.ts:4-6`.

`createPool` is a one-line pass-through over `new pg.Pool({ connectionString })`.
The interface (a function taking a URL) is as complex as the body. By the
book this is a shallow module — but it's a **defensible** one: it's the seam
where every CLI gets its pool, so a future swap (read replica, pool tuning,
pg config) lands in one place. Named here for honesty, not as a fix-now.
Walk in `audit.md` §2.

---

## One-line verdict per primitive

```
  primitive                  verdict
  ─────────────────────────  ───────────────────────────────────────────
  deep vs shallow modules    mostly DEEP; PgVectorStore is the best,
                             db.ts the one (defensible) shallow one
  information hiding         ONE real leak: the schema knob (config.ts:13
                             vs `agents.` in 5 files) + the meta contract
  layering                   CLEAN: adapter-behind-contract, pure core /
                             impure shells; no pass-through layers
  pull complexity downward   the dimension knob is correctly pulled down
                             (derived from embedder); the schema knob is
                             the counterexample — pushed up, does nothing
  errors & special cases     well-handled: txn rollback localized;
                             best-effort memory swallow is deliberate
  readability                strong; comments carry the WHY (the dropped
                             FK, the jsonb stringify); names are precise
  red flags                  2 firing (schema leak, undocumented meta),
                             1 N/A-but-noted (shallow db.ts)
```

---

## The single highest-leverage fix

**Delete or wire up `cfg.schema`.** It's the most complexity removed for the
least work: either drop the field from `config.ts` (and the `agents.`
hardcoding becomes honest — the schema simply *is* fixed), or thread it into
the five SQL sites (and the env knob becomes real). Today it's the worst of
both — a knob that looks configurable and isn't. One deletion buys you an
honest interface.

→ Full lens walk: `audit.md`.
→ The deep patterns: `01`–`05`.
