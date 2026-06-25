# Pass 1 — The APOSD audit (buffr-laptop)

> Updated: 2026-06-24 — `ask-cmd.ts` deleted; its wiring moved into a new deep-ish
> module `src/session.ts` (`createChatSession`). New Ink/React UI `src/cli/chat.tsx`
> (new deps: ink/react). Inline memory block replaced by aptkit's
> `createConversationMemory({ embedder, store })` (cleaner boundary, less code).
> Trace sink now handles all 6 event types. aptkit bumped to ^0.4.1. The two
> headline findings (dead `cfg.schema` knob + hardcoded `agents.`; the undocumented
> `meta` contract) STILL hold — the meta contract is now partly co-owned by
> @aptkit/memory.

Eight lenses from *A Philosophy of Software Design*, walked against this repo's
real files. Each lens names what the code actually does with `file:line`
grounding, or says `not yet exercised` honestly. The capstone (Lens 8)
consolidates the red-flag checklist. Where a finding earns a deep walk, it
cross-links to a Pass 2 pattern file rather than restating it.

The codebase: ~12 TS source files (now including `src/session.ts` and the
`src/cli/chat.tsx` Ink UI), ESM, consuming `@rlynjb/aptkit-core` ^0.4.1. Small and
young — several APOSD lenses have little to bite on, and that's stated plainly
rather than padded.

---

## Lens 1 — complexity in this codebase

The diagnostic overview. APOSD's three symptoms of complexity are *change
amplification* (one decision forces edits in many files), *cognitive load* (the
module nobody wants to touch), and *unknown-unknowns* (you can't tell what a
change will break). Here's where each lives.

**Change amplification — the schema name. STILL the worst spot (verified
2026-06-24).** The decision "the schema is called `agents`" is hardcoded as the
literal `agents.` in six SQL strings across five files: `src/profile.ts:6`,
`src/runtime.ts:12`, `src/pg-vector-store.ts:48`, `src/pg-vector-store.ts:73`,
`src/supabase-trace-sink.ts:6` (conversations) and `src/supabase-trace-sink.ts:28`
(messages). Rename the schema and you touch five files. Worse, `loadConfig` still
computes the schema name (`src/config.ts:13`) — so the fact lives in *seven* places
and the one that was meant to be the single source of truth is never read. The new
`session.ts` doesn't add a site (it calls into the same persistence helpers), so
the count is unchanged. This is the audit's headline finding; it recurs under Lens
3 (leakage) and Lens 5 (dead knob).

**Cognitive load — `PgVectorStore.upsert`.** Not a criticism — this is just where
the density is. `upsert` (`src/pg-vector-store.ts:38-65`) holds a transaction
(begin/commit/rollback/release), per-chunk dimension assertion, three
type-narrowing reads off `meta`, the JS→pgvector text encoding, and a 9-column
ON CONFLICT upsert. It's the most you have to hold in your head at once in this
repo. It earns it: that's a deep module doing real work, not accidental tangle.
→ deep walk in `01-adapter-behind-a-contract.md`.

**Unknown-unknowns — the `meta` shape contract. STILL undocumented, now
co-owned.** The riskiest hidden coupling. `upsert` reads `c.meta.docId`,
`c.meta.chunkIndex`, `c.meta.text` (`src/pg-vector-store.ts:44-46`) and `search`
rebuilds exactly those keys (`src/pg-vector-store.ts:83`). Those string keys are an
undocumented contract with aptkit's chunker on one side and aptkit's
`search_knowledge_base` tool's citation rendering on the other. **New as of
2026-06-24:** there's now a *third* writer of these keys — aptkit's
`createConversationMemory` (`src/session.ts:53`) embeds each exchange into the SAME
`PgVectorStore`, so memory chunks flow through the identical `upsert`/`search` meta
round-trip, tagged `kind=memory`. The contract is now partly @aptkit/memory's, but
it's still undocumented in buffr and still `Record<string, unknown>` with nothing
enforcing it. Change aptkit's chunk/memory meta keys and buffr silently writes
nulls. Textbook unknown-unknown — and the surface that depends on it just grew.

Highest-complexity hotspots by path, ranked:
1. The `agents.` schema literal (5 files) — change amplification.
2. `src/pg-vector-store.ts` `meta` key contract (lines 44-46, 83) — unknown-unknown.
3. `src/pg-vector-store.ts:38-65` `upsert` — concentrated but earned cognitive load.

---

## Lens 2 — deep vs shallow modules

Depth = functionality ÷ interface width. Best module = most behavior per unit of
surface. Worst = interface nearly as wide as the body (classitis).

**Deepest (best): `PgVectorStore`** — `src/pg-vector-store.ts:19-86`. Two public
methods (`upsert`, `search`) plus a `dimension` field. Behind them: connection
pooling, transaction management, dimension validation, the pgvector text-literal
encoding (`toVectorLiteral`, line 15), the cosine-distance→similarity inversion
(`1 - (embedding <=> $1)`, line 72), and the meta-shape round-trip. A caller
writes `await store.upsert(chunks)` and gets transactional, dimension-checked,
ANN-indexed persistence. That's the deepest module in the repo by a wide margin.
→ `01-adapter-behind-a-contract.md`.

**Newly deep (good): `ChatSession` / `createChatSession`** — `src/session.ts:29-76`.
The `ChatSession` interface is two methods, `ask(question)` and `close()`
(`src/session.ts:29-32`) — a *narrow* surface. Behind it `createChatSession` hides a
lot: it builds the pg pool, the Ollama embedder, `PgVectorStore`, the retrieval
pipeline + search tool, the context-guarded Gemma model, the profile load, the
injected `createConversationMemory`, a long-lived conversation row, the trace sink,
and the `RagQueryAgent` (`src/session.ts:34-57`). A caller does `const s = await
createChatSession(); await s.ask(q)` and inherits the entire warm-pool, single-
conversation, RAG-plus-memory machine. Functionality-to-interface ratio is high —
this is a genuine deep module, the second-best in the repo. Two small info-hiding
notes: (a) `ask` returns a bare `string`, hiding the trajectory/memory writes
entirely — good; (b) the only knob it *doesn't* hide is global env (`loadEnv()` /
`process.env` at `src/session.ts:35-36`), so unlike `loadConfig` this builder isn't
purely testable — it reaches for the environment itself. That's the one place its
interface is wider than it looks. Acceptable for a top-level wiring entry, but worth
naming: it's the impure shell with a deep module's shape.

**Shallowest (worst): `db.ts`** — `src/db.ts:4-6`. `createPool` is a one-line
pass-through: it takes a connection string and returns `new pg.Pool({
connectionString })`. The interface (one function, one arg) is as wide as the
body. This is a near-zero-depth module.

But here's the honest verdict: **that's fine, and you shouldn't "fix" it.** It's
a *seam*, not a deep module — its entire job is to be a single named place tests
can stub the pool factory. APOSD's classitis warning is about shallow modules
that pretend to add abstraction; this one is honestly a one-liner and its value
is substitutability, not behavior. Naming it earns its keep. The fix APOSD would
suggest (fold it into the caller) would *remove* the test seam, so don't.

`profile.ts` (`src/profile.ts:4-8`) and `runtime.ts` (`src/runtime.ts:5-18`) are
also thin — a single query each — but again sit right at the depth they should:
each owns one DB fact and hides the SQL. No classitis in the repo.

---

## Lens 3 — information hiding and leakage

A leak is a fact known in two modules that forces them to change together.

**The one real leak: the schema name `agents`.** Known in `loadConfig`
(`src/config.ts:13`, as `cfg.schema`) *and* hardcoded in every SQL string
(`src/pg-vector-store.ts:48,73`, `src/runtime.ts:12`, `src/profile.ts:6`,
`src/supabase-trace-sink.ts:6,15`). The config layer says "the schema is
configurable"; the data layer says "the schema is always `agents`." Both can't be
true. This is a seam where knowledge crosses that shouldn't — and it's worse than
a normal leak because one side (`cfg.schema`) is *dead*: it's computed and never
consumed (see Lens 5). The fix is to pick a side, not to "hide it better."

**A leak the schema deliberately chose to keep — and was right to.**
`sql/001_agents_schema.sql:15-17` documents that `chunks.document_id` is a *soft*
link to `documents.id` with **no foreign key**, with a comment explaining why:
the `VectorStore` contract upserts chunks with no notion of a documents row, so a
hard FK would break drop-in parity with the in-memory store. This is the textbook
case of "name the leak, then justify it." The knowledge that a chunk belongs to a
document leaks across the store/document boundary, but enforcing it in the DB
would couple the store to a fact the contract says it can't know. Keeping the FK
out is the *correct* call, and the comment is exactly the right place to record
it. Praise is a finding too — this is good design discipline.

**The `meta` key contract** (Lens 1's unknown-unknown) is also a leak: aptkit's
chunker and buffr's store must agree on `docId`/`chunkIndex`/`text` with nothing
enforcing it. It's milder than the schema leak because it's at least localized to
one file (`pg-vector-store.ts`), but it's undocumented.

No temporal decomposition found (no "do step 1 here, step 2 there because that's
the order it happens" smell). Config exposes no other internals.

---

## Lens 4 — layers and abstractions

Pass-through methods (a method that just forwards to another with no added value)
and adjacent layers offering the same abstraction.

**`runtime.ts` is borderline pass-through — and it's the interesting call.**
`indexDocumentRow` (`src/runtime.ts:5-18`) does two things: writes the
`documents` row, then calls `pipeline.index(...)`. The second half is a forward to
aptkit. If that were *all* it did, it'd be a pass-through to delete. But it isn't:
it adds the source-of-truth `documents` write that aptkit's pipeline knows nothing
about, and it sequences the two so the document row exists before its chunks. That
added behavior (and the ordering guarantee) is what keeps it from being a pure
pass-through. Verdict: earns its place, barely — watch it; if aptkit ever grows a
document concept, this layer collapses.

**No pass-through variables found.** The CLIs build objects and pass them down
(`pool`, `cfg`, `embedder`), but each consumer actually uses them — `pool` is
queried, `cfg.appId` is read, `embedder.dimension` flows into the store
(`src/cli/index-cmd.ts:19`). Nothing is threaded through a layer that doesn't
touch it.

**The wiring layer does not duplicate the persistence layer's abstraction.** The
one-shot commands (`cli/index-cmd`, `cli/eval-cmd`) are still pure wiring (env →
construct → run → drain). The chat path now splits in two: `session.ts` owns the
*construction + orchestration* (build the agent, run turns) and `cli/chat.tsx` owns
*presentation* (Ink render loop, input, busy state) — calling only `session.ask` /
`session.close`. Neither re-implements storage; the split is orchestration vs UI,
and the UI knows nothing of pools or aptkit. Clean separation, now across one more
seam. → walked in `02-pure-core-impure-shell.md`.

---

## Lens 5 — pull complexity downward

Knobs pushed up to callers that the module had enough information to decide
itself. APOSD: it's better for the module to eat the complexity than to export a
config knob.

**The dead knob: `Config.schema`.** `src/config.ts:13` exposes
`AGENT_DB_SCHEMA` → `cfg.schema`. No code reads it. This is the *opposite* of the
red flag in one sense (the complexity wasn't pushed up — it was pushed up and then
ignored) but it's a real defect: an exposed knob that does nothing is worse than
no knob, because it lies about what's configurable. Either pull it down (delete
it; the schema is `agents`, period) or wire it through. Today it's dead weight.

**`k` in `search` is pushed up correctly — but unvalidated.**
`src/pg-vector-store.ts:67` takes `k` and passes it straight to SQL `limit $3`
(line 76). `k` *should* be the caller's call (how many results they want). But the
module has enough information to defend its own query: a negative or zero `k` is
the store's to reject or clamp, not Postgres's to error on cryptically. Small
pull-down available: clamp `k` to `>= 1` inside the module.

**`embeddingModel` and `dimension` are pushed up with good defaults — correct.**
The constructor (`src/pg-vector-store.ts:25-30`) defaults `dimension` to 768 and
`embeddingModel` to `'nomic-embed-text:v1.5'`, but lets callers override. The CLI
passes `embedder.dimension` (`src/cli/index-cmd.ts:19`) so the store and embedder
agree on dimension at the wiring point. That's the right division: the module owns
a sane default, the caller owns the override when the embedder differs.

---

## Lens 6 — errors and special cases

Exception handling scattered across call sites; special cases a different
definition would erase.

**Mostly `not yet exercised` — and that's honest for a repo this small.** The
error strategy here is uniform and shallow-by-design: throw and let it bubble.
`assertDim` throws on dimension mismatch (`src/pg-vector-store.ts:33-34`); the
entry points throw on missing `DATABASE_URL` (`src/cli/index-cmd.ts:12`,
`src/session.ts:37`, `src/cli/eval-cmd.ts:11`) and missing args. For a single-device
CLI tool, "throw and die with a clear message" is the right error model; you don't
need aggregation or masking yet.

**One deliberate swallow worth naming (NEW 2026-06-24).** `session.ts` wraps the
memory write in a try/catch that intentionally drops the error:
`try { await memory.remember(...) } catch { /* swallow: best-effort */ }`
(`src/session.ts:65-69`). This is the *correct* kind of swallow — a comment names
why (a memory-write failure must not lose the answer the user already has) and it's
scoped to exactly one best-effort side effect, not blanket. It's the repo's first
recovery decision, and it's defined in one place with a rationale, not scattered.
The UI has a sibling: `chat.tsx` catches `session.ask` failures and renders them as
a turn rather than crashing (`src/cli/chat.tsx:30-32`) — again localized, again with
a clear purpose. Two intentional catches, both justified; still no try/catch sprawl.

**The two real transaction try/catch blocks are correct and not sprawl.**
`PgVectorStore.upsert` (`src/pg-vector-store.ts:59-64`) and `runMigration`
(`src/migrate.ts:11-19`) both follow the same begin/commit/rollback/release
shape. This is the *same* error pattern in two places — which is consistency, not
scatter. If a third transaction appears, that's the moment to extract a
`withTransaction(pool, fn)` helper and define the rollback-on-throw special case
out of every call site. Two occurrences is the watch-line, not yet the fix-line.

**One special case worth naming: the dimension-mismatch throw.** The constraint
"embeddings are 768-dim, a mismatch must throw, never silently truncate"
(project context) is enforced as an explicit guard (`assertDim`,
`src/pg-vector-store.ts:32-36`) called before both `upsert` and `search`. This is
the *opposite* of special-case sprawl — it's a special case correctly defined in
one private method and applied at both entry points. Good.

---

## Lens 7 — readability (names · comments · consistency · obviousness)

### names
Strong overall. `toVectorLiteral`, `assertDim`, `indexDocumentRow`,
`startConversation`, `persistMessage`, `loadProfile` — every name says what it
does. No `data`, `obj`, `tmp`, or `manager` anywhere. One nit (still live): `extra`
in `persistMessage` (`src/supabase-trace-sink.ts:21`, typed `MessageExtra` at
`:10-17`) is a vague name for a now-richer shape (`{ toolCalls?, toolResults?,
model?, tokensUsed?, createdAt? }`); `messageMeta` would say more. The shape grew
with the 6-event capture, which makes the vague name slightly more costly than
before. Still minor.

### comments
This repo's strongest readability facet. The comments carry *why*, not *what*:
the cosine-distance note (`src/pg-vector-store.ts:69`), the meta-rebuild rationale
(line 79), the no-FK justification (`sql/001_agents_schema.sql:15-17`), the
sync-emit/async-flush + full-trajectory contract (`src/supabase-trace-sink.ts:39-48`),
and the new memory-model docblock on `createChatSession` (`src/session.ts:13-28`),
which is unusually thorough about what's recalled, what's still missing, and whose
engine the memory is. These are
interface comments that capture decisions the code can't show. **The one missing
interface comment that matters:** `upsert` reads three magic keys off `meta`
(`docId`, `chunkIndex`, `text`) with no comment naming that contract
(`src/pg-vector-store.ts:44-46`). That's the highest-value comment the repo is
missing — add it.

### consistency
Consistent. Two transaction blocks use the identical begin/commit/rollback/release
shape (`pg-vector-store.ts:42-64`, `migrate.ts:10-19`). The remaining one-shot
entries (`index-cmd.ts`, `eval-cmd.ts`, `migrate.ts`) still use the identical
preamble (`loadEnv()` → `loadConfig` → `DATABASE_URL` guard → build → `pool.end()`).
`session.ts` follows the same build phase but inverts the teardown: instead of
`pool.end()` at the bottom of a script, it exposes `close()` for the long-lived
caller to invoke (`src/session.ts:72-74`). One job, one convention, with a
deliberate lifecycle variant for the chat session. No competing styles.

### obviousness
One "huh?" spot: the `1 - (embedding <=> $1::vector) as score` inversion
(`src/pg-vector-store.ts:72`) is non-obvious if you don't know pgvector's `<=>`
is *distance*, not similarity — but the comment on line 69 defuses it exactly.
Second: the `meta` round-trip in `search` (line 83) spreads `r.meta` then
overwrites `docId`/`chunkIndex`/`text` from the dedicated columns — obvious once
you see it, surprising at a glance because the same keys exist in both `meta` and
columns. Both are well-handled; no untyped-generics traps beyond the `meta`
contract already flagged.

---

## Lens 8 — red-flags-audit (the capstone checklist)

Ousterhout's red flags as a review checklist, marked against this repo, sorted by
severity for buffr.

```
  RED FLAG                        FIRES?  WHERE / FIX
  ──────────────────────────────  ──────  ───────────────────────────────────
  Information leakage              YES ★   schema name `agents` known in
                                          config.ts:13 + 6 SQL strings.
                                          FIX: pick one source; thread
                                          cfg.schema OR delete the knob.
  Avoidable config / dead knob     YES ★   Config.schema (config.ts:13) is
                                          computed, never read.
                                          FIX: delete it or wire it through.
  Hard-to-pick-name / vague name   MINOR   `extra` (trace-sink.ts:12).
                                          FIX: rename → messageMeta.
  Non-obvious (missing interface   MINOR   meta keys docId/chunkIndex/text
   comment)                               read in upsert (pg-vector:44-46),
                                          undocumented.
                                          FIX: one-line interface comment.
  Unvalidated knob pushed up       MINOR   `k` → SQL limit (pg-vector:76),
                                          no clamp.  FIX: clamp k >= 1.
  Shallow module / classitis       NO      db.ts is thin but it's a test
                                          seam, not classitis. Correct.
  Pass-through method              NO      runtime.indexDocumentRow adds a
                                          doc-row write + ordering. Earns it.
  Pass-through variable            NO      every threaded arg is consumed.
  Temporal decomposition          NO      no order-coupled split found.
  Try/catch everywhere            NO      two matching txn blocks =
                                          consistency, not sprawl.
  Special-case sprawl             NO      dim-mismatch defined once
                                          (assertDim), applied at both
                                          entry points. Good.
  Comment restates code           NO      comments carry why, not what.
  Conjoined methods               NO      none found.
```

**The actionable index, ranked:**
1. **Schema leak + dead knob** (fires twice — Lens 3 and Lens 5). The only
   finding that touches five files. Fix first.
2. **Missing `meta`-contract interface comment** (Lens 7). One line, removes the
   repo's worst unknown-unknown.
3. **Unvalidated `k`** (Lens 5). One clamp.

Everything else is either correct-as-is or genuinely `not yet exercised` because
the codebase is too small to grow that smell yet — named honestly, not padded.
