# Software Design — buffr-laptop (overview)

> Source framework: John Ousterhout, *A Philosophy of Software Design* (APOSD).
> This guide applies its primitives — deep modules, information hiding,
> complexity, layering, readability — to **this repo's real files**. Read the
> book for the framework; read this for the findings about your code. Cross-link:
> `read-aposd` (the framework), `study-system-design` (the altitude above this),
> `study-testing` (the seam this design buys you).

## The through-line

APOSD has one enemy and one weapon. The enemy is **complexity** — the thing that
makes a module hard to change without breaking something you didn't know was
connected. The weapon is the **deep module**: a lot of behavior hidden behind a
small interface, so callers learn a few names and inherit a lot of correctness.

buffr is a small, young codebase (10 source files, ~250 LOC of logic) — and it is
*unusually well-shaped for its size*. The reason is structural, not lucky: buffr
consumes `@rlynjb/aptkit-core` as a library and implements three of aptkit's
**contracts** (`VectorStore`, `CapabilityTraceSink`, `RetrievalPipeline`
consumer). When you implement someone else's interface, the interface width is
decided *for* you — you can't leak, because the contract won't let you. Most of
buffr's design quality is downstream of that one decision.

```
  buffr-laptop — where design quality comes from

  ┌─ aptkit-core (the library — never edited here) ──────────────┐
  │  defines contracts:  VectorStore   CapabilityTraceSink       │
  │                      RetrievalPipeline   RagQueryAgent        │
  └───────────────────────────┬──────────────────────────────────┘
                  buffr implements the contracts ▼  (narrow seam)
  ┌─ buffr persistence layer ────────────────────────────────────┐
  │  PgVectorStore      ← deepest module (★ best in repo)         │
  │  SupabaseTraceSink  ← sync emit / async flush                 │
  │  loadConfig         ← pure seam (testable)                    │
  │  db / runtime / profile / migrate  ← thin SQL helpers         │
  └───────────────────────────┬──────────────────────────────────┘
                              ▼  imperative shell
  ┌─ cli/ (index · ask · eval) ──────────────────────────────────┐
  │  wiring only: load env → build objects → run → drain pool    │
  └──────────────────────────────────────────────────────────────┘
                              ▼
  ┌─ Storage ────────────────────────────────────────────────────┐
  │  Postgres + pgvector  (schema `agents`, db `reindb`)          │
  └──────────────────────────────────────────────────────────────┘
```

## Verdict, ranked

1. **`PgVectorStore` is the deepest module in the repo** and the one to study —
   two public methods (`upsert`, `search`) hide transactions, dimension
   validation, the JS→pgvector text-literal encoding, the cosine-distance→score
   inversion, and the meta-shape rebuild that keeps citations working. Big
   behavior, tiny surface. `src/pg-vector-store.ts`.

2. **The CLIs are a clean imperative shell over a pure-ish core.** `loadConfig`
   is pure (env in, config out — `src/config.ts:9`); the `cli/*` files do all the
   I/O, env-loading, and pool teardown. The dirty work is pushed to the edges.

3. **One real leak, and it's a dead knob.** `loadConfig` computes
   `schema` from `AGENT_DB_SCHEMA` (`src/config.ts:13`), but every SQL string
   hardcodes the literal `agents.` (six call sites). The schema name is known in
   two places and the config knob is never read. Worst offender in the audit.

4. **The sync-emit / async-flush split in `SupabaseTraceSink` is a deliberate,
   load-bearing design move** — aptkit's `emit()` is synchronous, the DB write is
   not, so writes are queued as promises and drained once by `flush()`. Get it
   wrong and you either block the agent loop or lose the trajectory.

5. **Honest gap:** the codebase is too small to exercise most of APOSD's
   *failure* lenses (error aggregation, special-case sprawl, deep layering). It
   has 1-2 layers, not 5; errors are thrown and bubble. Named honestly in the
   audit rather than padded with manufactured findings.

## Reading order

```
  00-overview.md   ← you are here
  audit.md         ← the 8-lens APOSD walk (start here for the full read)
  01-adapter-behind-a-contract.md   ← PgVectorStore ↔ VectorStore (the deep module)
  02-pure-core-impure-shell.md      ← loadConfig vs the cli/* edges
  03-sync-interface-async-work.md   ← trace sink emit() / flush()
  04-dependency-as-a-boundary.md    ← aptkit imported, never edited
```

## Top 3 fixes (ranked across the whole repo)

1. **Kill the dead `schema` knob or wire it through.** Either delete
   `schema` from `Config` (`src/config.ts:13`) since nothing reads it, or thread
   `cfg.schema` into the SQL and stop hardcoding `agents.` in six files. Pick one;
   today the config lies. (See audit Lens 3 + Lens 5.)
2. **Give `PgVectorStore.upsert` a one-line interface comment naming the meta
   contract** it reads (`docId`, `chunkIndex`, `text`) — those keys are an
   undocumented coupling between the store and aptkit's chunker
   (`src/pg-vector-store.ts:44-46`). (See audit Lens 7.)
3. **Decide whether `search` should clamp/validate `k`.** Right now `k` passes
   straight to SQL `limit` (`src/pg-vector-store.ts:76`); a caller-supplied
   negative or zero is the module's to handle, not the caller's. (See audit
   Lens 5.)
