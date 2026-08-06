# Pass 1 — the 7-lens testing audit

Each lens below is one structured read of the `buffr-laptop` suite, grounded in `file:line` or marked `not yet exercised` honestly. When a finding is big enough to earn its own deep walk, the lens cross-links to the Pass 2 pattern file rather than restating it.

**Suite snapshot — this is a monorepo of 8 separate test suites, not one.** Run fresh (`DATABASE_URL` set, so DB-gated tests actually executed rather than skipping): root `test/` — **49 tests / 22 suites / 48 pass / 1 skip** (`gemma.live.test.ts`'s live-model smoke test, gated by its own `SKIP` constant, separate from the `DATABASE_URL` gate). Seven workspace packages each run their own `npm test` (`npm run build -w <pkg> && node --test dist/test/*.test.js`): `packages/kernel` — 65/65 pass across 22 suites; `packages/capabilities` — 34/34 across 6 suites; `packages/connectors` — 22/22 across 4 suites (`dist/test/discovery/*.test.js`); `packages/domain-packs/investing` — 5/5; `packages/domain-packs/market-research` — 3/3; `packages/engines/investing` — 3/3; `packages/engines/market-research` — 7/7. **Total: ~188 tests across 40 files, 187 pass, 1 skip, 0 fail** — none of it wired into one command, none of it wired into CI. This is a large correction from the last pass of this audit, which only walked the root `test/` directory (32 tests / 7 files) and never counted the seven package-level suites at all; they existed then too, this pass just walks them for the first time.

---

## Lens 1 — what is tested, and what isn't

The coverage map is in `00-overview.md`. The structural finding carries forward unchanged in shape, sharper in evidence: **testing went bottom-up, and stopped before it reached the trunk — and the trunk (`src/session.ts`) has grown considerably since the last pass while staying at zero tests.**

**What's tested at the package level (new to this pass, not previously walked):**

- `packages/kernel/test/` (22 suites, 65 tests) — `agents`, `cache`, `cached-embedding-provider`, `evals`, **`journal`** (8 tests, `InMemoryJournalStore` — create/listDue/snooze/resolve, plus the cross-tenant scoping regression test added in `41ecce8` → see `03-contract-parity-test.md`), `memory`, `model-gateway`, `prompt-registry`, `retrieval`, `tool-runtime`, `tracing`, `workflow-runtime`. All run with no `DATABASE_URL` gate — the kernel package has no Postgres dependency of its own; every model/tool call is stubbed.
- `packages/capabilities/test/` (6 suites, 34 tests) — `analyzer`, `collector`, `journal`, `scorer`, **`teacher`** (7 tests, incl. the principle/reflection-question fallback-vs-model-supplied pair, `teacher.test.ts:105-151`). Each capability is tested against a `StubModel` that returns canned `tool_use` responses keyed by tool name — the same "deterministic harness over a synthetic model" shape lens 6 already documents for the trace sink, now the dominant pattern across the whole capabilities layer.
- `packages/connectors/test/discovery/` (4 files, 22 tests) — `amazon-reviews`, `cached-connector`, `news-rss`, `search-trends`. Not previously audited; each connector's `fetch`/`toEvidence` contract is tested against fixture HTTP responses, not live network calls.
- `packages/domain-packs/{investing,market-research}/test/` — scorecard fixture tests (golden-fixture pattern, same shape as `06-fixture-based-scorer-accuracy.md`, just against the domain-pack's own `eval/fixtures.json` rather than `test/commands.test.ts`'s copy).
- `packages/engines/{investing,market-research}/test/engine.test.ts` — **`MarketResearchEngine`'s `collect()`/`evaluate()` split** (7 tests) is the most complete engine-level suite in the repo: evidence gathering + digest shape (`engine.test.ts:93-105`), a dedicated **"safe digest" test that walks every key in the digest object and asserts none of `summary/positives/negatives/score/confidence/findings` leaked into it** (`engine.test.ts:108-144` — a real information-hiding assertion, not just a shape check), the happy-path evaluate with comparison math, a memory-write assertion (`remember()` called once, with the right `conversationId`), a dimension-mismatch comparison, and — added in `41ecce8` — a **zero-findings test that pins the fallback introduced by that same commit** (`engine.test.ts:200-208`, `actualDimension === 'unknown'` instead of crashing on `findings[0]!`). `InvestingEngine`'s suite (`engines/investing/test/engine.test.ts`) is thinner — 3 tests, happy-path company and ETF scoring plus a memory-write check — no equivalent zero-findings guard, because `InvestingEngine.evaluate()`'s strongest-finding reduction was never the one that crashed; the fix only touched market-research.

**What's tested at the root `test/` level (updated from last pass):**

- `loadConfig`, `runAllMigrations` (was `runMigration` — the runner now loops `MIGRATION_FILES = ['001_agents_schema.sql', '002_decision_journal.sql']`, see `04-idempotent-migration-test.md`), `PgVectorStore`, `loadProfile`, `indexDocumentRow`, `SupabaseTraceSink`, `detectEntityType` + Scorer fixture accuracy (`commands.test.ts`, unchanged since last pass) — all still hold, all still accurate.
- **`test/pg-journal-store.test.ts` (NEW, 5 tests, `DATABASE_URL`-gated)** — `PgJournalStore` against `agents.decisions`: create/round-trip for both `hypothesis` and `decision` kinds, `listDue` scoped by user/workspace, snooze + resolve. The second, Postgres-side half of the `JournalStore` contract → see `03-contract-parity-test.md`'s new section on how this diverges from the `PgVectorStore` parity shape.
- **`test/research-flow.test.ts` (NEW, 7 tests) and `test/review-flow.test.ts` (NEW, 6 tests)** — the interactive `/research` and `/review` conversations, tested as pure state machines with an injected `ChatSession` stub. Genuinely new testing *technique* in this repo → earned its own pattern file, `07-scripted-multi-turn-flow-test.md`.
- `test/amazon-tool.test.ts`, `test/db-sources.test.ts`, `test/rss-tool.test.ts`, `test/trends-tool.test.ts` — **NEW since last pass, not previously audited.** These close the exact gap the previous pass flagged as its #2 finding ("connector tools — zero tests"): the Amazon/RSS/Trends tool wrappers and `src/db-sources.ts`'s `DbSource[]` config are now tested. `src/cli/index-db-cmd.ts`'s `sanitize()` helper is still not directly unit-tested (it's exercised indirectly through `db-sources.test.ts`'s fixtures at best) — worth a direct check next pass.
- `test/gemma.live.test.ts` — **NEW**, a genuine live-model smoke test (`'Gemma smoke: tool_use → retrieval → synthesis'`, gated by its own `SKIP` const, not `DATABASE_URL`) — the closest thing in the repo to the e2e layer the previous pass flagged as entirely absent. Still not run by default; still worth naming as a deliberate, narrow e2e probe rather than "no e2e at all."

**What isn't tested, ranked by risk — carried forward, and the top item has gotten worse:**

- **`src/session.ts` — 883 lines, the orchestrator, still zero tests.** `ChatSession`'s interface now spans 15 methods (`session.ts:103-125`): `ask`, `analyze`, `evalInvesting`, `evalResearch`, `suggestResearchTopics`, `connectorStatus`, `researchCollect`, `researchEvaluate`, `saveHypothesis`, `saveDecision`, `dueReviewCount`, `listDueReviews`, `snoozeReview`, `resolveReview`, `close`. Every one of `research-flow.test.ts` and `review-flow.test.ts`'s tests works precisely *because* they stub this entire interface rather than exercising the real implementation — which means the flow tests prove the flows are correct assuming `session.ts` honors its own interface, and nothing proves that assumption. **Red flag firing, harder than last pass:** the surface area of the most complex, least-tested file grew substantially (from ~7 methods to 15) since the last audit, with zero new tests.
- **`src/cli/chat.tsx` — grown to 474 lines, still zero tests.** Now wires both flow controllers (`activeFlow` state, `chat.tsx:128-130`), the `busy`/`activeFlow` re-entrancy logic (`chat.tsx:157`, tightened by `41ecce8` to let empty input through *only* when a flow is active — see lens 5), `/investing`, `/eval`, `/research`, `/review` handlers, and the startup `dueReviewCount().catch(() => 0)` guard also added by `41ecce8`. Every one of these is a real branch with defined behavior; none has a test.
- **The two-tier DB-touching test surface is still green-by-skip in a fresh clone / CI**, now across *eight* separate `npm test` invocations instead of one — see lens 7.
- `src/db.ts`, `src/cli/index-cmd.ts` — unchanged, still too thin to warrant a test.
- `src/cli/eval-cmd.ts` — still the eval/reporting script, not a unit test → `study-ai-engineering`.

---

## Lens 2 — test design and levels

The pyramid shape changed materially since the last pass — **there is now a real, large, always-run unit layer**, and it lives almost entirely in the workspace packages, not in root `test/`.

```
  The pyramid as-built (monorepo-wide)

         ┌──────────────────────────────────────────────┐
   unit  │ kernel (65) · capabilities (34) · connectors  │  126 tests, 32 files,
         │ (22) · domain-packs (5) · engines (10)         │  no DB, no live LLM —
         │ loadConfig, detectEntityType, scorer fixtures  │  StubModel + fixture JSON
         └──────────────────────────────────────────────┘
       ┌──────────────────────────────────────────────────┐
  integ│ migrate · pg-vector · profile · runtime ·          │  ~40 tests, 9 files,
       │ trace-sink · pg-journal-store · amazon/rss/trends  │  real Postgres,
       │ /db-sources tools                                  │  DATABASE_URL-gated
       └──────────────────────────────────────────────────┘
     ┌──────────┐                    ┌──────────────────────┐
e2e  │ gemma.live│ 1 test, SKIP-gated │  research/review-flow │ 13 tests, in-process
     │ (real Gemma)│                  │  (stubbed session,    │ state-machine —
     └──────────┘                    │   no real terminal)   │ not e2e, but the
                                       └──────────────────────┘ closest thing to it
```

**What the design still gets right, unchanged from last pass:** no over-mocking against the DB — the one place a dependency is faked at the DB layer is the embedder, and that's a network substitute, not an assertion target → `02-fake-embedder-injection.md`. What's *new* and worth naming: the same discipline — inject the dependency at a typed interface, fake it deterministically — now runs across the whole monorepo. `StubModel` (a `ModelProvider` returning canned `tool_use` responses) appears independently in `packages/capabilities/test/teacher.test.ts`, `packages/engines/market-research/test/engine.test.ts`, and `packages/engines/investing/test/engine.test.ts` — three separately-authored copies of the same idea, not a shared test helper. That's a smaller-scale version of the same duplication risk `03-contract-parity-test.md`'s new JournalStore section documents at the store level: the *pattern* is consistent, but nothing forces it to stay that way as more engines are added.

**What's missing at the levels, updated:**

- **No shared unit layer for the flow objects' dependencies.** `research-flow.test.ts` and `review-flow.test.ts` each define their own `makeStubSession()` (duplicated, not imported from one place) — same risk shape as the `StubModel` duplication above, one level up the stack.
- **The integration tests are still also the unit tests for their modules** — `toVectorLiteral` (`pg-vector-store.ts:15-17`) is still untested in isolation, unchanged from last pass.
- **`gemma.live.test.ts` is the honest e2e answer the previous pass said was "arguably correct to skip."** It exists now, gated behind its own flag rather than `DATABASE_URL`, and it's the one place in the whole suite that calls a real Gemma model. Worth noting explicitly rather than re-flagging "no e2e" — the gap that remains is `session.ts`/`chat.tsx` end to end, not the model call itself.

---

## Lens 3 — tests as design pressure

The one clear untestable seam from last pass is **unchanged and slightly worse**: `src/cli/chat.tsx` still runs `await createChatSession()` and `render(...)` at module top level (now near the end of the grown file, `chat.tsx:462`) — importing the module for a test still fires a real session, a real pool, a real Ollama embedder, a real `loadProfile` query. That's a design finding, not a testing one → cross-link `study-software-design`.

**What's new and genuinely good design pressure resolved correctly:** the interactive-conversation problem — the same shape of "hard to test because it's tangled with I/O" that `chat.tsx`'s bootstrap exhibits — was solved for `/research` and `/review` by extraction *before* the tangle formed. `createResearchFlow`/`createReviewFlow` (`src/cli/research-flow.ts`, `src/cli/review-flow.ts`) hold their own state in closures and depend on nothing but an injected `ChatSession`; `chat.tsx` is reduced to a thin dispatcher (`activeFlow.controller.submit(q)`, `chat.tsx:170`) around them. This is the same "depend on an injected interface, not a global" discipline `loadConfig`, `PgVectorStore`, and `SupabaseTraceSink` already modeled — applied here to something stateful and multi-turn, which is a harder case to get right and the repo got it right. See `07-scripted-multi-turn-flow-test.md` for the full walk. The contrast is instructive: the *conversation logic* escaped the untestable-bootstrap problem; the *rest* of `chat.tsx` (the `busy` guard, the slash-command dispatch, the error turn) did not, because it was never extracted the same way.

**41ecce8's chat.tsx fixes are exactly where this gap shows up in practice.** Two of that commit's five fixes touched `chat.tsx` — the empty-input-when-flow-active bug (`handleSubmit`'s guard, `chat.tsx:157`) and the unguarded `dueReviewCount()` startup call (`chat.tsx:461`) — and **neither got a regression test**, because neither *can*, without the same bootstrap-decoupling `chat.tsx`'s top-level `await` currently blocks. Contrast with the other three fixes in the same commit (the market-research zero-findings guard, the `InMemoryJournalStore` scoping bug — both tested; the `research-flow.ts` prompt-copy change — untestable by nature, it's a string) — the split is a clean natural experiment: bugs in already-decoupled, already-tested modules got regression tests in the same commit; bugs in the one still-coupled module didn't, because there was nowhere to put them.

Everywhere else the design still *helps* the tests, unchanged from last pass:

- `loadConfig(env)` takes env as a parameter — pure function, trivially testable.
- `PgVectorStore`, `indexDocumentRow`, `SupabaseTraceSink`, `loadProfile`, `PgJournalStore` all take their `pool` as a constructor/parameter dependency. None reaches for a global.

So the design-pressure verdict, updated: **one untestable seam (`chat.tsx` bootstrap), one seam that used to be a candidate for the same problem and got extracted in time (the flow objects), everything else injectable.**

---

## Lens 4 — determinism, isolation, and flakiness

Still the suite's strongest lens, unchanged mechanisms, now proven at greater scale. `--test-concurrency=1`, `app_id`-scoped `beforeEach` cleanup, the fake embedder, and the trace-sink's hand-set-timestamp ordering assertion all carry forward exactly as documented in the last pass → `02-fake-embedder-injection.md`, `05-full-signal-trajectory-assertion.md`.

**What's new:** the flow tests (`07-scripted-multi-turn-flow-test.md`) and the package-level `StubModel` tests add a *third* determinism mechanism, structurally different from the DB-cleanup and fake-embedder patterns: **no shared mutable state to clean up in the first place.** Each test constructs its own flow object / engine / capability from scratch with its own stub, so there is no `beforeEach` needed — isolation comes from never sharing an instance, not from resetting one. That's a cheaper and arguably more robust form of isolation than the DB tests' cleanup-by-`app_id` pattern, available specifically because these modules have no ambient state to begin with.

One correction to the "green-by-skip" framing from last pass: with `DATABASE_URL` actually set (as it is in this environment's `.env`), the DB-gated tests are not merely present-but-skipped — they ran, for real, against live Postgres, as part of gathering this pass's evidence. The gate is real insurance for a machine *without* the env var (a fresh clone, most CI runners as currently configured — see lens 7), not evidence the tests are decorative.

The honest gap carried forward unchanged: **`PgVectorStore.search` ranking is asserted as `>=`, not exact** (`pg-vector-store.test.ts:39`), a deliberate loosening for HNSW's approximate-nearest-neighbor behavior, not a sloppy one → `03-contract-parity-test.md`.

---

## Lens 5 — edge cases and error paths

Thicker than last pass — two new regression tests close real gaps, though the underlying honest gaps mostly remain.

**What's newly tested on the unhappy path (both from `41ecce8`):**

- **The market-research zero-findings guard.** `MarketResearchEngine.evaluate()` used to crash on `analyzerResult.data.findings[0]!` when the analyzer returned no findings; the fix guards it and `engine.test.ts:200-208` asserts `actualDimension === 'unknown'` and `dimensionMatched === false` instead of a throw. A real crash-to-degrade fix, tested at the exact boundary that used to fail.
- **The `InMemoryJournalStore.listDue` cross-tenant scoping leak.** `journal.test.ts:76-91` asserts a `listDue` call scoped to one user/workspace cannot flip another user's/workspace's entry to `review-due` as a side effect. See `03-contract-parity-test.md` for the full account, including the honest gap that the equivalent assertion was never added to `pg-journal-store.test.ts`.
- **The flow tests' invalid-input paths** — malformed predictions, invalid dates, out-of-range scores, empty stake/resolution text — all re-prompt at the same step without side effects, and (for the prediction case) with an explicit assertion that the expensive `researchEvaluate` call never fired → `07-scripted-multi-turn-flow-test.md`.

**What's still not tested, carried forward:**

- **The swallowed memory-write `catch` (`session.ts`, unchanged from last pass).** Still zero tests on this deliberately-eaten error branch.
- **The migration rollback path (`migrate.ts`'s `runMigration`, unchanged).** Still only the success/reapply path is tested, now across two files instead of one — see `04-idempotent-migration-test.md`'s updated Elaborate section.
- **New gap this pass: migration file *ordering*.** `MIGRATION_FILES` is a hardcoded array; nothing tests (or could test, with the current run-twice shape) that a future file gets appended in the right position. Named explicitly in `04-idempotent-migration-test.md`'s Interview defense.
- **The `pg-vector-store.ts` transaction rollback — unchanged, still untested.**
- **`chat.tsx`'s error turn and the two `41ecce8` chat.tsx fixes — still untested, and structurally can't be until the bootstrap decouples** → lens 3.

No property-based testing anywhere, unchanged assessment from last pass.

---

## Lens 6 — testing AI features

Still the seam the whole guide organizes around, and the pattern has **spread consistently across the monorepo** rather than staying a one-off.

The trace-sink test (`supabase-trace-sink.test.ts`) remains the clearest textbook instance: synthetic `CapabilityEvent`s in, exact assertions on persisted rows out, Gemma never in the loop → `05-full-signal-trajectory-assertion.md`. What's new this pass is seeing the *same shape* repeated at the capability and engine level, independently:

```
  The AI-testing seam, now with several concrete instances in this repo

  ┌─ probabilistic core (NOT tested directly) ─────────────┐
  │  RagQueryAgent.answer() / Analyzer / Teacher / Scorer    │   → eval seam,
  │  → all call a ModelProvider (Gemma in production)        │      study-ai-engineering
  └──────────────────────┬────────────────────────────────────┘
                         │ replaced in tests by a StubModel returning
                         │ canned tool_use responses keyed by tool name
  ┌─ deterministic harness (tested here) ─────────────────┐
  │  Teacher.execute() → teacher.test.ts (7 tests)          │
  │  MarketResearchEngine.evaluate() → engine.test.ts (7)   │
  │  InvestingEngine.evaluate() → engine.test.ts (3)         │   ← this guide
  │  SupabaseTraceSink.emit() → supabase-trace-sink.test.ts  │
  └────────────────────────────────────────────────────────────┘
```

`teacher.test.ts:105-151`'s principle/reflection-question pair is worth naming specifically: it tests *both* the fallback (the model omits `principle`/`reflectionQuestion` → the code derives a fallback referencing the strongest dimension) and the pass-through (the model supplies them → they're used verbatim) as two separate, exact assertions. That's the right shape for testing a "model output with a code-side default" boundary — assert the default deterministically, assert the pass-through deterministically, and never try to assert anything about what a real model would produce.

Where it hands off, unchanged: retrieval quality (`eval-cmd.ts`, precision@k/recall@k) and the Scorer/scorecard fixture accuracy files (`06-fixture-based-scorer-accuracy.md`, now also present independently in `packages/domain-packs/market-research/test/scorecard.test.ts` against a repo-local `eval/fixtures.json` — a fourth instance of the golden-fixture pattern, not previously counted) are the evaluation half, `study-ai-engineering`'s territory.

**The gap on this lens, sharpened:** `session.ts` is where every one of these deterministic harnesses gets *composed* into a real conversation — and it's exactly the file with zero tests. Testing `Teacher`, `MarketResearchEngine`, and `SupabaseTraceSink` in isolation proves each piece is right; nothing proves `session.ts` wires them together correctly (right order, right error handling, right data threaded from `researchCollect` to `researchEvaluate` to the trace sink).

---

## Lens 7 — testing red-flags audit (capstone)

The consolidated checklist, marked against this repo, monorepo-wide.

| Red flag | Firing? | Evidence |
|----------|:---:|----------|
| Most important / most complex code is least tested | **YES, WORSE** | `session.ts` grew from ~7 to 15 interface methods with zero new tests; every other module in the monorepo gained real coverage this cycle (lens 1). |
| Heavy mocking that tests the mock, not the code | no | `StubModel`/stub-session fakes are deterministic substitutes for a real dependency, not assertion targets — now proven at scale across 6 packages, not just one file (lens 2, lens 6). |
| Inverted pyramid (all slow/flaky e2e) | no | The opposite problem if anything: a large fast unit layer (126 tests, no DB/LLM) now dominates the monorepo; `gemma.live.test.ts` is the sole, gated e2e probe (lens 2). |
| Flaky: passes/fails on rerun, no code change | no | Same mechanisms as last pass, now also backed by the flow tests' and stub-model tests' "no shared state to begin with" isolation (lens 4). |
| Tests require a specific run order | no | Unchanged — each file/package owns its own cleanup or has none to own (lens 4). |
| Zero tests on error/exception branches | **PARTIAL, IMPROVED** | Two real regression tests landed this cycle (market-research zero-findings, journal scoping leak) alongside the flow tests' invalid-input paths; the swallowed `session.ts` catch and both migration rollback paths remain untested (lens 5). |
| AI feature with no test at the deterministic boundary | no | The pattern spread rather than regressed — Teacher, both engines, the trace sink, and four independent golden-fixture files all cover their respective boundaries (lens 6). |
| Green-by-skip: suite passes while testing almost nothing | **CHANGED SHAPE, STILL A REAL GAP** | No longer "one suite skips DB tests" — it's now **eight separate `npm test` commands**, none wired together, none wired into CI (no `.github/workflows` directory in the repo). A machine without `DATABASE_URL` set still gets a green root suite while skipping every DB-touching test in it; a CI run that only executed `npm test` at the root would additionally miss all ~139 tests living in the seven workspace packages entirely, since the root script only runs `dist/test/*.test.js`. |

**1 firing (worse than last pass), 1 partial (improved), and the "green-by-skip" flag changed shape into something arguably more urgent.** The orchestration-trunk gap didn't just persist, it grew — every package around `session.ts` got tested this cycle, and `session.ts` itself didn't move. The CI gap went from "one suite might run without its DB half" to "there is no single command that runs this repo's full test suite, so even a maximally diligent CI setup pointed at `npm test` would silently cover about a quarter of the tests that exist." Both are still fixable without rearchitecting: one test file for `session.ts` with injected fakes (the exact discipline `research-flow.test.ts`/`review-flow.test.ts` already demonstrate one layer up), and either a root script that loops every workspace's `npm test` or a CI matrix job per package, plus a Postgres service container for the DB-gated half.

The honest "not yet exercised" list, stated plainly:

- **A single command that runs every test in the repo.** Eight separate `npm test` invocations exist; nothing composes them.
- **CI** — still no workflow anywhere in the repo; still green-by-skip on a fresh clone, and now also incomplete-by-scope if CI only ever targets the root package.
- **`src/session.ts`** — the orchestration trunk, 15 public methods, zero tests, the single highest-leverage gap in the repo.
- **e2e of `chat.tsx` against a live model** — `gemma.live.test.ts` proves the model call works; nothing proves the UI, the flows, and `session.ts` compose correctly end to end.
- **Error-branch coverage** — the swallowed memory-write catch, both migration rollback paths, migration file ordering, the `pg-vector-store.ts` transaction rollback, the two `41ecce8` `chat.tsx` fixes.
- **A shared test-fixture layer** — `StubModel` and `makeStubSession()` are each independently re-implemented per test file rather than imported from one place; low risk today, worth watching as more engines/flows are added.
