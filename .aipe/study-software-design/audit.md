# audit.md — the 8-lens APOSD audit of buffr-laptop

Pass 1. Walk the codebase against Ousterhout's design primitives, one
lens per `##` section, each grounded in `file:line`. Where a lens finds
nothing real, it says `not yet exercised` rather than manufacturing a
finding. Where a finding earns a deep walk, it cross-links to the Pass 2
pattern file instead of restating it.

A note on size before we start: this is still a small, single-device
codebase, but it's no longer a young one. It's a monorepo with six
packages (`packages/kernel` — now including `journal/`, `packages/
connectors`, `packages/contracts`, `packages/capabilities`, `packages/
domain-packs/{investing,market-research}`, `packages/engines/
{investing,market-research}`) plus ~20 root source files (`src/`). Two
things changed enough since the last audit to move the needle: (1)
`session.ts` grew from ~400 to **883 lines**, and its exported
`ChatSession` interface grew from 4 methods to **15**, spanning four
product surfaces (chat, investing, market research, the decision
journal); (2) a second Postgres-backed subsystem landed — `agents.
decisions`, `PgJournalStore`, and the `JournalStore` port it shares with
a test double — and a real behavioral-contract bug shipped and got
caught between those two adapters (`41ecce8`). Most APOSD red flags still
bite hardest in big multi-team codebases, so plenty of lenses are still
"too small to show meaningful X yet" — but two lenses that were quiet
last time (`session.ts`'s size, and information leakage) now have real
material.

```
  the 8 lenses, ranked by what they found in THIS repo

  FIRES / WORTH READING            QUIET / TOO SMALL YET
  ───────────────────────          ─────────────────────
  1. complexity — session.ts is    4. layers (clean; CLI flows
     now the #1 hotspot               keep domain logic OUT —
  3. info-hiding (dead schema         a new praise finding)
     knob + the JournalStore       7. readability (clean; a
     contract that drifted)           few micro-nits)
  8. red-flags — god-class watch
     escalated to FIRES
  6. errors (mostly handled well,
     but a real crash shipped and
     got fixed — good case study)
  5. pull-complexity-down
     (still the model example)
  2. deep-vs-shallow (deepest
     module unchanged; facade's
     breadth is the new story)
```

---

## 1. complexity-in-this-codebase

The zoom-out. APOSD names three symptoms of complexity: **change
amplification** (one decision forces edits in many files), **cognitive
load** (the module nobody wants to touch), and **unknown-unknowns** (you
can't tell what you'd have to change). Let's locate each in real files.

**Cognitive load — the new #1 hotspot: `session.ts` itself.** At 883
lines and 15 exported methods across four domains (chat, investing,
market research, journal review), this is now the file with the most
going on, full stop — more than `pg-vector-store.ts` ever had. The good
news: it's still not the *bad* kind of complexity, because every method
is individually deep (see lens 2) — nobody has to read all 883 lines to
call `ask()`. The real symptom is different from "hard to use"; it's
"hard to *own*": a change to how `AgentContext` is built (`userId`/
`workspaceId`/`traceId`/`domain`/`now`/`permissions`) is hand-repeated at
four call sites (`session.ts:695-697`, `715-722`, `732-739`, `852-859`)
because four unrelated domains share one file. That's change
amplification at the *intra-module* scale — normally this red flag fires
between files; here it fires between four responsibilities crammed into
one. → full walk in `05-deep-session-facade.md`.

**Change amplification — the still-live instance: the hardcoded schema.**
`config.ts:13` computes `schema: env.AGENT_DB_SCHEMA || 'agents'`. Still
nothing reads `cfg.schema` — the literal `agents.` is still hardwired
into every SQL string across `pg-vector-store.ts`, `runtime.ts`,
`profile.ts`, `supabase-trace-sink.ts`, and now also `pg-journal-store.ts`
(`agents.decisions`, seven call sites total now). Full treatment in
lens 3.

**Unknown-unknowns — two instances now, one old, one new.** The
undocumented `PgVectorStore` meta contract (`docId`/`chunkIndex`/`text`,
`pg-vector-store.ts:44-46,80-84`) is unchanged from the last audit. The
new one: `JournalStore.listDue`'s side-effect contract
(`packages/kernel/src/journal/contracts.ts:61-65`) — "any decision with
status `open` and `reviewAt <= now` flips to `review-due` as a side
effect of being listed... both implementations must do this
identically" — is stated only in a comment, and it silently *didn't*
hold until `41ecce8` fixed it. A new contributor implementing a third
`JournalStore` adapter has no compiler check telling them what
"identically" means. → lens 3, and `01-adapter-behind-a-contract.md`'s
third worked example.

**The hotspots, ranked:**
1. `session.ts` — 883 lines, 15 methods, 4 bundled domains (new #1;
   lens 2, lens 8, `05-deep-session-facade.md`).
2. `config.ts` ↔ seven SQL-writing files — the dead-`schema` leak
   (lens 3).
3. `pg-vector-store.ts:44-46,80-84` and `contracts.ts:61-65` — two
   implicit contracts, one old (still open), one new (fixed once, no
   shared test yet).

**New additions, low complexity on their own:** `packages/kernel/src/
journal/contracts.ts` is a clean 72-line port definition — no logic,
just types and one behavioral doc comment. `src/pg-journal-store.ts` is
a straightforward CRUD adapter, one method per SQL statement, no branch
complexity worth naming. `packages/engines/market-research/src/engine.ts`
splits what used to be one `run()`-shaped job into `collect()`/
`evaluate()` (238 lines total) — individually each method is simpler
than `InvestingEngine.run()`'s single body, even though the *system*
gained a state machine (`research-flow.ts`) to hold the seam between
them. → `07-collect-then-evaluate-split.md`.

---

## 2. deep-vs-shallow-modules

Depth = functionality ÷ interface width. Deep is good (lots of behaviour,
tiny surface); shallow is the red flag (interface nearly as wide as the
body — **classitis**, a class that adds a layer without hiding anything).

**The deepest module, unchanged — `PgVectorStore` (`pg-vector-store.ts:
19-86`).** Interface: two methods plus a readonly `dimension`. Body
hides a transaction, a dimension guard, JS→pgvector encoding, a
cosine→similarity flip, and a meta round-trip. **Still the best deep
module in the repo, and nothing this cycle touched it.** →
`01-adapter-behind-a-contract.md`.

**`createChatSession` — same subsystem depth, very different interface
story now.** Each individual method is still deep: `researchCollect`
(`session.ts:713-726`) is three lines hiding a full connector fan-out;
`dueReviewCount`/`listDueReviews` (`session.ts:784-790`) are one line
each hiding a Postgres `UPDATE`-then-`SELECT`. No method in the fifteen
is a bare pass-through. What changed is the *aggregate*: the interface
went from 4 methods (last audit) to **15**, spanning chat, investing,
market research, and the journal — four product surfaces behind one
factory function. Individually-deep-but-collectively-wide is a shape
APOSD doesn't have a single red flag for; the closest is the "god class"
checklist item, and it's the right lens here (see lens 8, now escalated
to FIRES). The evidence that this is a real seam, not a hypothetical
one: the three actual callers (`cli/chat.tsx`, `research-flow.ts`,
`review-flow.ts`) already partition the fifteen methods with zero
overlap between them — the split the module wants is visible in usage
today. → full walk, diagrams, and the fix in `05-deep-session-facade.md`.

**`PgJournalStore` (`src/pg-journal-store.ts:41-117`) — a second deep
adapter, smaller stakes.** Four methods (`create`/`listDue`/`snooze`/
`resolve`), each a thin wrapper over one or two SQL statements. Shallower
than `PgVectorStore` in absolute terms (no transaction, no encoding
step), but it hides real things: the `rowToEntry` mapper
(`pg-journal-store.ts:9-39`) absorbs the `snake_case` column ↔ `camelCase`
field translation and all the `null → undefined` coercions in one place,
so no caller does that conversion. Depth is modest but real, and the
interface earns it. → `01-adapter-behind-a-contract.md`.

**The shallowest modules — unchanged, still fine.** `db.ts` and
`profile.ts` are still one-function-one-decision modules — thin, but
each names a real decision, no classitis. No fix needed.

**Verdict, updated:** the *per-module* design instinct is still right —
every individual module this cycle added (`PgJournalStore`, the
capability classes, both engines) is deep on its own terms. The new
finding isn't about any single module's depth; it's that one module
(`createChatSession`) is now the load-bearing point for four unrelated
depths at once. That's worth fixing before a fifth domain lands.

---

## 3. information-hiding-and-leakage

The lens that fires hardest this cycle. A leak is a fact known in two
places that forces them to change together. Two real leaks now — one
carried over, one new and more interesting.

**THE leak, still open — the dead `cfg.schema` knob.** `config.ts:13`
still computes a `schema` field nothing reads; the literal `agents.` is
now hardcoded in **seven** places (`pg-vector-store.ts` ×2, `runtime.ts`,
`profile.ts`, `supabase-trace-sink.ts` ×2, and now `pg-journal-store.ts`
— `agents.decisions`). Same fix as before: delete the field, or thread
it everywhere. **Recommended: delete.** Still the single highest-leverage
cheap fix in the repo, and it got *more* expensive to ignore (one more
call site joined) without anyone actually needing the knob.

**The new leak, and the interesting one — the `JournalStore` contract
that only a comment enforces.** `contracts.ts:61-65` documents a
behavioral requirement across two adapters (`InMemoryJournalStore`,
`PgJournalStore`): `listDue()` must transition matching `open` decisions
to `review-due` **scoped to the calling `userId`/`workspaceId`**, as a
side effect, identically in both implementations. Until `41ecce8`,
`InMemoryJournalStore.listDue` ran that transition over *every* stored
entry regardless of caller — unscoped — while `PgJournalStore.listDue`
was correctly scoped from the start (`pg-journal-store.ts:87-92`, a
`where app_id = $1 and user_id = $2 and workspace_id = $3` on the
`update`). The bug: a test written against the in-memory adapter could
pass while exercising behavior the production adapter would never
actually exhibit — the test double was quietly *more permissive* than
reality.

```
  the same knowledge (the review-due transition rule), enforced in 2 places,
  and only 1 of the 2 got it right until a review pass caught the gap

  contracts.ts:61-65    "both implementations must do this identically"
       │                        (a COMMENT — no compiler check)
       ├──────────────────────────────┬──────────────────────────────┐
       ▼                              ▼
  PgJournalStore.listDue          InMemoryJournalStore.listDue
  (pg-journal-store.ts:86-92)     (in-memory-journal-store.ts:37-53)
  scoped by app_id/user_id/       BEFORE 41ecce8: unscoped —
  workspace_id  ✓ correct         transitioned EVERY entry ✗
                                  AFTER 41ecce8: scoped, matches ✓
```

This is the information-leakage red flag in a form the rest of this
guide hasn't shown yet: the leaking "knowledge" isn't a constant (like
the schema name) or a data shape (like the vector-store meta keys) — it's
a *behavior*, and the only thing carrying it between the two
implementations is prose in a doc comment. TypeScript's structural typing
happily accepts both versions of `listDue` as satisfying `JournalStore`;
nothing in the type system can express "and do the same side effect."
**The fix that would have caught this before a review pass had to:** one
shared contract-test suite (a single test file parameterized over both
adapter constructors) that asserts the same behavior against both — the
kind of test `01-adapter-behind-a-contract.md`'s worked example names as
the general lesson. → full walk in `01-adapter-behind-a-contract.md`'s
third worked example.

**The third leak, unchanged — the implicit `PgVectorStore` meta
contract (`docId`/`chunkIndex`/`text`).** Same as last audit, still
open, still the right fix (a typed `ChunkMeta` + a comment naming the
three required keys). → `01-adapter-behind-a-contract.md`.

**Not a leak (worth noting, unchanged):** the soft `document_id` link
with no FK is still a deliberate, well-documented decision, not a leak.

---

## 4. layers-and-abstractions

Find pass-through methods and pass-through variables. Adjacent layers
offering the same abstraction earn no keep.

**New praise finding — the CLI flows keep domain logic OUT, and the
boundary is clean.** `research-flow.ts` and `review-flow.ts` are
interactive state machines living in the CLI layer (`src/cli/`), and the
worry with any UI-layer state machine is that domain logic creeps in
where it's easy to reach for (parsing, then just... computing the
answer right there). It didn't happen here. `research-flow.ts`'s
`formatDigest`/`formatReveal`/`parsePrediction`/`PREDICTION_PROMPT` are
all *presentation and input-parsing* concerns — they turn typed values
into strings and strings into typed values. The actual domain
computation — `PredictionComparison`'s `scoreGap`/`dimensionMatched` —
is computed inside `MarketResearchEngine.evaluate()`
(`engine.ts:202-208`), never in the CLI. `formatReveal`
(`research-flow.ts:56-69`) only *reads* `output.comparison` fields the
engine already computed; it doesn't derive them. Same story in
`review-flow.ts`: `parseDisposition` is a pure string→enum parser, and
the actual state transition (`open` → `resolved`) happens in
`PgJournalStore.resolve` (`pg-journal-store.ts:110-116`), not the CLI.
**This is the layering doing its job under new pressure** — two fairly
complex interactive flows landed in the UI layer and neither one
smuggled domain logic across the boundary. No fix; worth naming as the
positive control case for lens 4.

**The two pass-throughs from last audit — unchanged.** `runtime.ts:17`'s
pass-through to `pipeline.index` still earns its place (it does real
work first). The `appId` pass-through variable is still load-bearing at
every layer it threads through, now including `pg-journal-store.ts`'s
`appId` field (`pg-journal-store.ts:43,47`), which follows the same
"used, not just forwarded" pattern as everywhere else it appears.

**Verdict:** still `not a problem in this repo` — and the new CLI-layer
material is a genuine strength, not just an absence of a smell.

---

## 5. pull-complexity-downward

The red flag: a knob or parameter pushed up to the caller that the
module had enough information to decide itself.

**Still the model example, and a new instance of the same discipline.**
`PgVectorStore`'s dimension guard (unchanged from last audit) is still
the sharpest example. The new instance: `MarketResearchEngine.evaluate()`
computes the *entire* prediction-vs-actual comparison in code
(`engine.ts:196-208`) — score gap, dimension match, the strongest
finding — rather than asking the model to eyeball the difference or
pushing that arithmetic up into `research-flow.ts`. The doc comment says
it outright: "computes the prediction comparison in code (never asks the
model to invent the gap)" (`engine.ts:120-121`). The caller
(`research-flow.ts`) only formats the already-computed `comparison`
object. This is the same "the module decides, the caller doesn't" shape
as the dimension guard, applied to a different kind of decision
(arithmetic instead of validation).

**The counter-example, still open — `cfg.schema`.** Unchanged: a knob
nobody turns, still exported, still ignored. See lens 3.

**Unchanged, still fine:** `embeddingModel`/`appId` on
`PgVectorStoreOptions`, and `PgJournalStoreOptions.appId`
(`pg-journal-store.ts:4-7`) follows the identical pattern — optional,
defaulted to `'laptop'`, the module owns the common case. Consistent with
the established convention.

---

## 6. errors-and-special-cases

Find exception handling scattered across call sites, and special cases a
better definition would erase.

**A real crash shipped and got caught — the best case study in the
repo for this lens.** `MarketResearchEngine.evaluate()` used to compute
its "strongest finding" with a bare non-null assertion:

```ts
// the shape of the bug, before 41ecce8
const strongestFinding = analyzerResult.data.findings.reduce(
  (max, f) => (f.score > max.score ? f : max),
  analyzerResult.data.findings[0]!,   // ← crashes if findings is empty
);
```

The method's own doc comment names an invariant — "assumes
`collected.evidence.length > 0`" (`engine.ts:122-123`) — and the caller
*does* honor that half of the contract (`research-flow.ts:85-88` checks
`digest.totalCount === 0` before ever reaching this code path). But
non-empty evidence does not imply the Analyzer returns non-empty
findings — an LLM can look at real evidence and produce zero findings —
and that's the exact gap the stated invariant didn't cover. The fix
(`41ecce8`, `engine.ts:196-201`) generalizes the fallback pattern the
same function already used for `keyProblems`/`productAngles`/
`explanation` (`engine.ts:185-194`) to also cover `strongestFinding`:
guard the empty case, degrade to `'unknown'`/`false` instead of
crashing. **This is exactly what APOSD means by defining a special case
out of existence** — the fix doesn't add a try/catch, it makes "zero
findings" a value the function can represent instead of an assertion
failure. → the full contract-across-a-checkpoint story is in
`07-collect-then-evaluate-split.md`.

**Errors still handled at the right altitude elsewhere — unchanged.**
`loadProfile`'s `?? ''` default, `SupabaseTraceSink.emit`'s no-`default`
switch, the transaction rollback masked inside `upsert`, the one
aggregated try/catch in the chat UI, and the deliberate `memory.remember`
swallow in `ask()` are all unchanged from the last audit and still good
examples.

**A second, smaller instance from the same review pass.** `chat.tsx`'s
startup sequence used to call `session.dueReviewCount()` unguarded,
which meant a fresh database or a transient connection hiccup would
crash the whole CLI before the first render. `41ecce8` wraps it:
`session.dueReviewCount().catch(() => 0)` (`chat.tsx:461`) — a
best-effort read on startup degrades to "nothing due" instead of taking
the process down. Same shape as the `memory.remember` swallow: a
non-critical read, failed silently, with the failure mode chosen
deliberately (0 due reviews is always a safe default to show).

**The one gap worth naming, unchanged:** the dimension guard and
`DATABASE_URL` checks still throw bare `Error`. Still fine for a
single-device CLI. `mostly not yet exercised.`

---

## 7. readability — names · comments · consistency · obviousness

Four facets, one lens. Still clean; two new micro-nits joined the old
ones.

**Names — unchanged, still strong.** No new vague names anywhere in the
journal or market-research additions — `rowToEntry`, `formatDigest`,
`parsePrediction`, `currentEntry` all say what they do.

**Comments — still the strength of the codebase, one new example worth
copying.** `contracts.ts:61-65`'s doc comment stating the `listDue` side
effect and the "both implementations must do this identically" clause
is exactly the kind of interface comment lens 7 keeps praising — it
names a fact the type signature can't. The irony (see lens 3) is that
this particular comment turned out to be necessary but not *sufficient*:
it stated the rule correctly but nothing enforced it, so it's a good
example of comments' real limit — they inform a careful reader, they
don't compile-check a careless one.

**New nit — the `ChatSession` type reads as a flat list with no
domain grouping.** `session.ts:102-126` declares all fifteen methods in
declaration order with no separating comments (`// chat`, `// investing`,
`// research`, `// journal`) even though the four domains are real and
the callers already respect them (lens 2, lens 4). A reader skimming the
type today has to reverse-engineer the grouping from method names. Cheap
fix, independent of whether the bigger facade-split (lens 8) ever
happens: four one-line banner comments would make the existing structure
visible immediately.

**The two nits carried over, unchanged:** the missing `ChunkMeta`
key-contract comment (lens 3), and the `chunkIndex`/`content` default
inconsistency (`pg-vector-store.ts:45-46`).

**Consistency — one more instance of the schema split, otherwise
unchanged.** `pg-journal-store.ts` joined the "every query hardcodes
`agents.` while config claims it's variable" club (lens 3) — same root
cause, one more symptom.

**Verdict, unchanged:** readability is still a strength. The two new
findings (the ungrouped `ChatSession` type, the `listDue` comment that
was correct-but-unenforced) are both small and both point at the same
underlying story as lenses 2 and 3 — this repo's comments are excellent
at *describing* contracts; it doesn't yet have a habit of *testing* the
ones that cross an adapter boundary.

---

## 8. red-flags-audit — the capstone checklist

Ousterhout's red flags as a review checklist, each marked against this
repo: **FIRES** / doesn't / N/A / **WATCH**, with location and the
one-line fix when it fires. Sorted by severity for buffr. Two rows moved
since the last audit — one escalated, one newly fired-and-fixed.

```
  RED FLAG                        VERDICT   WHERE / FIX
  ──────────────────────────────  ────────  ─────────────────────────────
  God class / over-large module    FIRES     session.ts: 883 lines, 15
   (escalated from WATCH)         ★ new     methods, 4 unrelated domains
                                    worst     behind ONE factory function.
                                             Callers already partition it
                                             0-overlap → split into 4 thin
                                             domain facades over 1 shared
                                             build-once context (lens 2,
                                             05-deep-session-facade.md)

  Information leakage              FIRES     (a) cfg.schema vs 7 hardcoded
   (same knowledge, two places)   ★ tied    'agents.' literals (unchanged)
                                    worst     (b) NEW: JournalStore's
                                             listDue side effect, stated
                                             only in a comment, drifted
                                             between 2 adapters until
                                             41ecce8 (lens 3)

  Hard-to-describe (implicit       FIRES     meta keys docId/chunkIndex/
   contract, no type/comment)      minor     text still not typed (lens 3)

  Nonobvious code                  FIRES     content '' / chunkIndex 0
                                   minor     defaults hide missing-key bug

  Special case undefined           FIXED     MarketResearchEngine crashed
   (fired, then caught in review)  in       on empty findings; assertion
                                    review   → explicit guard in 41ecce8
                                             (lens 6). Good case study —
                                             keep, don't need to re-fix.

  Shallow module / classitis       doesn't   db.ts/profile.ts thin but
                                             earn it; PgJournalStore hides
                                             a real row-mapping decision

  Pass-through method/variable     doesn't   runtime.ts adds real work;
                                             appId used at every layer,
                                             including the new journal store

  Temporal decomposition           doesn't   modules split by concern

  Comment restates code            doesn't   comments carry WHY — a repo
                                             strength (lens 7), though
                                             the JournalStore case shows
                                             a comment's real limit: it
                                             can't compile-check itself

  Try/catch everywhere             doesn't   errors aggregated low; 2 new
                                             deliberate swallows this
                                             cycle (dueReviewCount at
                                             startup, same shape as the
                                             existing memory.remember one)

  Vague names (data/obj/tmp/mgr)   doesn't   names still precise repo-wide

  Repetition (same code N times)   FIRES     NEW: AgentContext construction
                                   minor     hand-repeated at 4 call sites
                                             in session.ts (lens 1) — a
                                             symptom of the god-class row,
                                             not a separate root cause

  Temporal coupling via module-    FIRES     currentOnStatus / currentOnTokens
   level mutable state             minor     unchanged from last audit —
                                             not worse, not yet fixed
```

## Discovered patterns (updated this cycle)

Three patterns now exercise the repo's capability + engine layer:

**`capability-as-typed-computation-unit`** — unchanged from last audit.
Each capability (`Collector`, `Analyzer`, `Scorer`, `Teacher`, `Journal`
in `packages/capabilities/src/`) has a single typed input/output
contract, is independently instantiable, and composes by explicit
wiring, no shared mutable state, no base class. → `06-capability-as-
typed-computation-unit.md`.

**`engine-as-linear-pipeline`** — `InvestingEngine.run()` fixes the step
order in code, one `async` call start to finish. Unchanged. Still
described inline here rather than as its own Pass 2 file — it's the
*absence* of the interesting move, and the interesting move (the
contrast with it) now has its own file.

**`collect-then-evaluate-split` (new)** — `MarketResearchEngine` doesn't
have a `run()`; it has `collect()` and `evaluate()`, split at exactly the
point where a human prediction has to land between evidence-gathering
and scoring, so the predict-then-reveal ritual (`/research`'s core
product feature, context.md) can capture the guess before the model's
answer exists to bias it. Same five capabilities as `InvestingEngine`,
genuinely different topology — the engine shape follows the product
requirement (a checkpoint), not a stylistic preference. This is where
this cycle's empty-findings crash (lens 6) actually happened, because
the contract carried across the checkpoint was named incompletely. →
`07-collect-then-evaluate-split.md`.

**The actionable index, ranked across the whole repo:**

1. **Split `createChatSession`'s interface along the domain boundary
   the callers already respect.** Four thin facades (chat / investing /
   research / journal) over the one shared build-once context. The
   highest-leverage fix this cycle — the god-class row is the new worst
   offender, and unlike the schema knob it's a structural cost that
   compounds with every new domain. `session.ts:102-126` (the type),
   `session.ts:394-665` (the shared build-once block to keep).
   `05-deep-session-facade.md`.
2. **Write one shared contract-test suite for `JournalStore`'s
   `listDue` side effect, run against both `InMemoryJournalStore` and
   `PgJournalStore`.** The bug that shipped (unscoped transition in the
   in-memory adapter) is exactly the class of bug a parameterized
   contract test catches before review has to. `contracts.ts:61-65`.
   `01-adapter-behind-a-contract.md`.
3. **Delete the dead `cfg.schema` knob.** Still open, now seven call
   sites instead of six. `config.ts:3,13`.
4. **Type the `PgVectorStore` meta contract.** `ChunkMeta` + a comment
   naming `docId`/`chunkIndex`/`text` as required. `pg-vector-store.ts:
   4,79`. Unchanged from last audit — still not fixed.
5. **Add domain-grouping banner comments to `ChatSession`.** Cheap,
   immediate readability win independent of whether/when the facade
   split (#1) lands. `session.ts:102-126`.
6. **Throw (or warn) on missing `text` meta.** Unchanged, still open.
   `pg-vector-store.ts:46`.

Everything else is praise, or genuinely "too small to bite yet." The
overall shape hasn't changed: the design instincts here (deep modules,
why-comments, pulling complexity down into the module that owns it) are
still right, and the codebase caught its own worst bug this cycle
(`41ecce8`) via review rather than shipping it silently — which is
itself evidence the discipline is working. The new work is at the
*composition* altitude, not the module altitude: individual pieces are
still well-built; the place they're wired together (`session.ts`) is the
one place that's outgrown its original shape.
