# audit.md — Pass 1: the 8-lens APOSD walk

Eight lenses, each one `##` section. Every claim cites a real path and line
range, or honestly says `not yet exercised`. The capstone (§8) is the
red-flag checklist sorted by severity for this repo.

The conceptual treatment of each primitive lives in the book (and, once
generated, in `.aipe/read-aposd/`). This file is the application.

---

## 1. Complexity in this codebase

The zoom-out for the whole audit. Where does a single change amplify, where
does cognitive load spike, where do the unknowns hide?

buffr is eight small source files. Total complexity is low — there's no
god-object, no 400-line method, no tangle. The symptoms cluster in exactly
two seams, and they're both *information leaks*, not size problems.

```
  Change-amplification map — "to change X, how many files do I touch?"

  change the schema name "agents"   → 6 files   ✗ amplifies (the leak)
  change the embedding dimension    → 0 callers ✓ derived from embedder
  change the meta key "docId"       → 3 places  ✗ amplifies (the contract)
  swap pgvector for another store   → 1 file    ✓ the adapter contains it
  add a CapabilityEvent type        → 1 file    ✓ contained in trace sink
```

The two rows marked ✗ are the whole complexity story:

- **The schema name** lives in `config.ts:13` as a computed-but-unread knob,
  and as a hardcoded `agents.` literal in `pg-vector-store.ts:48,73`,
  `runtime.ts:12`, `supabase-trace-sink.ts:6,28`, and `profile.ts:6`. Six
  edit sites for one decision. → §3, §5.
- **The `meta` magic keys** (`docId`, `chunkIndex`, `text`) are a contract
  with no type, known in `pg-vector-store.ts:44-46` (write), `:83` (read),
  and inside aptkit's pipeline + citation tool. → §3, and the deep walk in
  `01-adapter-behind-a-contract.md`.

**The module nobody wants to touch without care:** `pg-vector-store.ts`. Not
because it's bad — it's the deepest, best module — but because the `meta`
contract and the `$1::vector` cast are subtle, and the SQL is the one place
a typo silently degrades retrieval instead of throwing.

**Highest-complexity hotspots by path:**
1. `src/config.ts:13` + the five `agents.` sites — the schema leak.
2. `src/pg-vector-store.ts:44-46,83` — the undocumented meta contract.
3. `src/session.ts:34-76` — the most *moving parts* in one function (deep,
   but the place a reader holds the most state at once).

---

## 2. Deep vs shallow modules

Depth = functionality ÷ interface size. The best module hides a lot behind
a little; the worst has an interface nearly as wide as its body.

**Deepest module (best): `PgVectorStore`** — `src/pg-vector-store.ts:19-86`.

Three public methods (`dimension`, `upsert`, `search`) over a body that hides:
transaction management (`begin`/`commit`/`rollback`, `:42,58,60`), the
dimension guard (`:32-36`), JS-`number[]` → pgvector text-literal encoding
(`:14-17`), the cosine-**distance**-to-**similarity** flip (`:69`,
`1 - (embedding <=> $1)`), and the `meta` round-trip (`:44-46,83`). A caller
writes `store.search(vec, k)` and gets back hits — none of that machinery
surfaces. That's the deepest module in the repo and the reason the whole
pgvector graduation was invisible to aptkit. Deep walk:
`01-adapter-behind-a-contract.md`.

**Deep facade (runner-up): `createChatSession`** — `src/session.ts:34-76`.
Two-method interface (`ask`, `close`, declared `:29-32`) over a body that
constructs and *holds* a warm pool, embedder, store, pipeline, tool,
registry, guarded model, profile, memory engine, conversation id, trace
sink, and agent (`:39-57`). Eleven collaborators behind two methods. Deep
walk: `05-deep-session-facade.md`.

**Shallowest module (worst, but defensible): `createPool`** —
`src/db.ts:4-6`.

```ts
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });
}
```

The interface — a function taking a string, returning a `Pool` — is as
complex as the one-line body. By the book that's a shallow module: it adds a
layer without hiding anything (`pg.Pool` is still the return type; the caller
still knows it's pg). **But** it's the single seam where every entry point
(`session.ts:39`, `migrate.ts:27`, `index-cmd.ts:17`, `eval-cmd.ts:13`) gets
its pool. The fix the book would suggest — inline it — would scatter
`new pg.Pool(...)` across four files and lose the one place to add a read
replica or pool config later. **Verdict: leave it.** A shallow module that
centralizes a future decision is a seam, not a smell. Naming it here is the
honest call, not a fix-now.

`profile.ts` (`:4-8`) and `db.ts` are both thin, but neither is classitis —
there are no over-split one-method classes in this repo. The codebase is too
small and too disciplined to exercise classitis meaningfully.

---

## 3. Information hiding and leakage

A leak is a decision known in two modules that forces them to change
together. buffr has two — one severe, one inherent to the adapter.

**Leak 1 (severe): the schema name.** `src/config.ts:13` computes
`schema: env.AGENT_DB_SCHEMA || 'agents'`. Then **nothing reads it**. Every
query hardcodes the literal:

```
  src/pg-vector-store.ts:48   insert into agents.chunks ...
  src/pg-vector-store.ts:73   from agents.chunks
  src/runtime.ts:12           insert into agents.documents ...
  src/supabase-trace-sink.ts:6   insert into agents.conversations ...
  src/supabase-trace-sink.ts:28  insert into agents.messages ...
  src/profile.ts:6            select content from agents.profiles ...
```

The schema decision is hidden *nowhere* — it's smeared across six sites, plus
a seventh (`config.ts:13`) that pretends to own it and doesn't. This is the
textbook *information leakage* red flag and the *same-knowledge-edited-twice*
red flag at once. The fix is in §5 (pull the decision down) — but the leak
itself is the finding: the schema name is not a hidden decision, it's a
copy-pasted one.

**Leak 2 (inherent): the `meta` magic-keys contract.**
`src/pg-vector-store.ts:44-46` reads `c.meta.docId`, `c.meta.chunkIndex`,
`c.meta.text`; `:83` rebuilds exactly those keys. The same three strings are
known to aptkit's pipeline (which fills `meta` on index) and to the
`search_knowledge_base` tool (which reads `meta.text` for citations,
referenced in the comment at `:79`). Three modules, one untyped contract,
no interface comment naming the keys. Change `docId` to `documentId` on one
side and retrieval silently breaks. This is leakage too — but unlike Leak 1
it's *partly inherent*: the adapter's whole job is to bridge buffr's table
shape and aptkit's in-memory `meta` shape, so some knowledge must cross. The
fix isn't to remove the crossing; it's to **name the contract** — a
`ChunkMeta` type and one interface comment. Deep walk:
`01-adapter-behind-a-contract.md`.

**No temporal decomposition found.** The modules split by *responsibility*
(store, profile, trace, session), not by *time-of-execution* (no
`step1.ts` / `step2.ts`). That's the right axis. Honest praise.

---

## 4. Layers and abstractions

Looking for pass-through methods (a method that just forwards to another at
the same abstraction) and adjacent layers offering the same abstraction.

**No pass-through layers.** Trace the call chain and each layer changes the
abstraction:

```
  one question — "what abstraction does each layer add?" — traced down

  chat.tsx        UI: turns, busy state, /exit        (React/Ink)
     │  session.ask(q)  ← string in, string out
     ▼
  session.ts      orchestration: persist→answer→        (lifecycle owner)
     │            flush→remember
     ▼
  RagQueryAgent   (aptkit) reasoning loop               (the contract edge)
     │  store.search / store.upsert
     ▼
  pg-vector-store SQL + pgvector + meta round-trip       (storage adapter)
     │  pool.query(...)
     ▼
  pg.Pool         connection management                 (driver)
```

Every arrow *flips an abstraction*: UI turns → a string question → an agent
run → a vector search → a SQL row. No layer just re-exposes the layer below.
The one candidate for a pass-through — `createPool` (§2) — forwards to
`new pg.Pool` without adding abstraction, but it's a *seam*, not a layer in a
chain (nothing calls through it to reach something else).

**`indexDocumentRow` is the cleanest example of a layer earning its place.**
`src/runtime.ts:5-18`: it writes the source-of-truth `documents` row *and
then* calls `pipeline.index()`. That's two abstractions fused into one
operation the caller can't get wrong — you can't index chunks without
recording the document they came from. `index-cmd.ts:24` calls it once and
gets both. A layer that fuses two must-happen-together steps is the opposite
of a pass-through.

---

## 5. Pull complexity downward

A knob pushed up to the caller that the module had enough information to
decide itself is misplaced complexity. The module should eat the
complexity so N callers don't each have to.

**The counterexample done right: `dimension`.** `PgVectorStore`'s constructor
takes an optional `dimension` (`src/pg-vector-store.ts:11,29`), defaulting to
768. But the CLIs don't hardcode 768 — they pass `embedder.dimension`
(`session.ts:41`, `index-cmd.ts:19`, `eval-cmd.ts:15`). The dimension is
*derived from the embedder that produces the vectors*, so the store and the
embedder can never disagree. The complexity (what dimension are we?) is
pulled down to its source. This is the model to copy.

**The knob to pull down (or delete): `schema`.** `config.ts:13` exposes
`AGENT_DB_SCHEMA` as a caller-facing knob. The *avoidable config exposed to
users* red flag fires hard here, because the knob doesn't even work — §3
showed every query ignores it. Two honest fixes:

- **Delete it.** The schema *is* `agents`, fixed by the migration
  (`sql/001_agents_schema.sql`). Drop `cfg.schema`, accept that the literal
  is the truth, and the interface stops lying.
- **Pull it down.** Thread `cfg.schema` into the five SQL sites (or, better,
  into `PgVectorStore`/`profile`/`trace-sink` constructors so the SQL builders
  own it). Then the knob is real and the decision is hidden in one layer.

Either is fine. The current state — a knob that's neither real nor gone — is
the only one that isn't. → highest-leverage fix, `00-overview.md`.

---

## 6. Errors and special cases

Looking for try/except scattered across call sites, and special cases a
different definition would erase.

**Error handling is localized and deliberate — this lens is a strength.**

- **Transaction rollback is defined in one place, twice.** `upsert`
  (`pg-vector-store.ts:41-64`) and `runMigration` (`migrate.ts:9-20`) both
  wrap work in `begin`/`try`/`catch → rollback`/`finally → release`. The
  error path is *inside* the module that owns the transaction, not pushed to
  callers. A caller of `upsert` never sees a half-written batch. That's
  "define errors out of existence" applied correctly: partial writes are not
  a state any caller can observe.
- **The dimension mismatch throws, never truncates.** `assertDim`
  (`:32-36`) is called before every write (`:39`) and every search (`:68`).
  The context.md constraint — "a mismatch must throw, never silently
  truncate" — is enforced as a guard at the boundary, so the special case
  (wrong-size vector) becomes an exception, not a silent corruption.
- **Best-effort memory is a deliberate special case, swallowed low.**
  `session.ts:64-69`: the `memory.remember` call is wrapped in
  `try { ... } catch { /* swallow */ }`, with the comment "a memory-write
  failure must not lose the answer the user has." This is the *right* place
  to swallow — at the exact site where the failure is non-fatal and the
  contract (the user already has their answer) makes silence correct. It is
  not try/except sprawl; it's one intentional swallow with a stated reason.

**The one place errors cross a boundary as data:** `tool_call_end` events
carry `error` into the trace as a *value*, not a thrown exception
(`supabase-trace-sink.ts:69`). A failed tool call is recorded, not raised —
correct, because the agent loop continues past a tool failure. Special case
handled by definition (an error is just another event field).

---

## 7. Readability — names, comments, consistency, obviousness

Four facets in one lens, ranked within each.

**Names — precise, almost no vague placeholders.** No `data`, `obj`, `tmp`,
or `manager` in `src/`. Names carry intent: `assertDim`, `toVectorLiteral`,
`toJsonb`, `indexDocumentRow`, `persistMessage`. The one weak spot is
single-letter loop binds in the hot path — `c` for chunk (`:39,43`), `r` for
row (`:80`), `v` for vector (`:15,32`). They're conventional and local, so
they read fine; not a finding, just the only place precision dips.

**Comments — carry the WHY, not the what. This is the repo's strongest
readability trait.** Three comments earn their place by explaining a decision
the code can't:

- `pg-vector-store.ts:69` — `<=> is cosine DISTANCE; cosine similarity score
  = 1 - distance.` Without it, `1 - (...)` looks like a magic constant.
- `supabase-trace-sink.ts:23-24` — explains the explicit `JSON.stringify`:
  "so array payloads aren't mistaken for a Postgres array literal by
  node-postgres." That's a bug-prevention comment; only a comment can carry
  it.
- `session.ts:18-28` — the memory-model block, including the honest "Still
  missing: sequential in-prompt turn history" — a comment documenting what
  the code *doesn't* do yet. Rare and valuable.

**The one missing interface comment:** `PgVectorStore` has no comment naming
the `meta.docId`/`chunkIndex`/`text` contract (§3, Leak 2). The class's most
fragile coupling is the one undocumented thing. Add a `ChunkMeta` type and a
one-line doc; it's the highest-value comment not yet written.

**Consistency — one convention per job.** Pools are always made via
`createPool`. Env is always loaded via `loadEnv()` then `loadConfig`. SQL is
always parameterized (`$1`, `$2`...). jsonb is always stringified via
`toJsonb`. No two-ways-to-do-one-thing found.

**Obviousness — one "huh?" spot.** `pg-vector-store.ts:55,77` cast with
`$N::vector` *inside the SQL string* while passing `toVectorLiteral(vector)`
(a `[0.1,0.2]` string) as the param. The cast-in-SQL + serialize-in-JS split
is non-obvious — you have to read both to see why a `number[]` becomes a
string becomes a `vector`. The comment at `:14` covers the serialize half;
the cast half is only obvious if you know pgvector. Minor, but it's the spot
a new reader pauses.

---

## 8. Red-flags audit — the capstone checklist

Ousterhout's red flags as a review checklist, marked against this repo,
sorted by severity. This is the actionable index the rest of the audit feeds.

```
  red flag                         status   location / one-line fix
  ───────────────────────────────  ───────  ──────────────────────────────
  Information leakage               ✗ FIRES  schema name in 6 sites
  (same knowledge, many edits)               (config.ts:13 + 5 SQL files)
                                             → delete cfg.schema or thread it

  Avoidable config / exposed knob   ✗ FIRES  config.ts:13 AGENT_DB_SCHEMA —
                                             a knob no query reads
                                             → §5; same fix as above

  Hidden / undocumented contract    ✗ FIRES  pg-vector-store.ts:44-46,83
  (implied interface)                        meta docId/chunkIndex/text,
                                             untyped → add ChunkMeta type
                                             + interface comment

  Shallow module                    ⚠ NOTED  db.ts:4-6 createPool — true
                                             but defensible (the pool seam);
                                             leave it, don't inline

  Non-obvious code                  ⚠ MINOR  pg-vector-store.ts:55,77
                                             ::vector cast split across
                                             SQL + JS → one comment closes it

  Pass-through method/variable      ✓ CLEAR  none — every layer flips the
                                             abstraction (§4)

  Temporal decomposition            ✓ CLEAR  modules split by responsibility,
                                             not by execution order (§3)

  Try/except sprawl                 ✓ CLEAR  rollback localized; one
                                             deliberate swallow (§6)

  Comment restates code             ✓ CLEAR  comments carry WHY, not what
                                             (§7) — a strength

  Classitis (over-split classes)    — N/A    repo too small/disciplined to
                                             exercise it (§2)

  Vague names                       ✓ CLEAR  names are precise (§7)
```

**Severity order for this repo:** fix the schema leak first (it's both a
leak and a false promise, and the fix is a deletion), then name the `meta`
contract (one type + one comment), then optionally annotate the `::vector`
cast. Everything else is clear or a defensible call.

---

### Where the lenses didn't bite — honest notes

- **Classitis / over-engineering:** `not yet exercised`. Eight files, none
  over-split. The repo is too small and too disciplined to show this red
  flag meaningfully.
- **Deep inheritance / abstraction towers:** `not yet exercised`. buffr uses
  composition and a single `implements VectorStore` / `implements
  CapabilityTraceSink`; no class hierarchies to audit.
- **Cross-module duplication beyond the schema literal:** `not yet
  exercised`. The CLIs share a near-identical bootstrap (load env → config →
  pool → embedder → store → pipeline: `index-cmd.ts:10-20`,
  `eval-cmd.ts:9-16`), which is mild duplication — but it's four lines of
  wiring, below the bar for a finding. Watch it if a fifth CLI appears; that's
  the moment to extract a `bootstrap()` seam.
