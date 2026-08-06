# Overview — the testing audit at a glance

`buffr-laptop` is a monorepo with **8 separate test suites — root `test/` plus 7 workspace packages** — totaling **~188 tests across 40 files, 187 pass, 1 skip, 0 fail** (run fresh with `DATABASE_URL` set, so the DB-gated half actually executed rather than skipping). Root `test/` alone is 49 tests / 22 suites / 48 pass / 1 skip (`gemma.live.test.ts`, gated by its own flag). The seven workspace packages — `kernel` (65), `capabilities` (34), `connectors` (22), `domain-pack-investing` (5), `domain-pack-market-research` (3), `engine-investing` (3), `engine-market-research` (7) — each run their own `npm test`; none of them ran in the previous pass of this audit, which only ever looked at root `test/`.

The verdict: **the test design is sound everywhere it exists, and it now exists almost everywhere** — real integration against Postgres where SQL is the thing being proven, a large fast unit layer built on injected `StubModel`s where a probabilistic core needs a deterministic stand-in, and a genuinely new pattern (interactive flows tested as pure state machines) for the two multi-turn CLI conversations. The problem still isn't quality, it's *one specific piece of coverage*: the orchestration layer that ties the whole agent together — `src/session.ts` — has **grown to 15 public methods and still has no test at all.**

---

## Coverage map — the RISK map, not the percentage

```
  buffr-laptop — what has tests, what doesn't (monorepo-wide)

  ┌─ Unit (ALWAYS run, no DB, no live LLM) ───────────────────────────┐
  │  packages/kernel/test/          ✓ 65 tests, 22 suites              │ ← new this pass
  │  packages/capabilities/test/    ✓ 34 tests, incl. Teacher           │ ← new this pass
  │  packages/connectors/test/      ✓ 22 tests, discovery connectors    │ ← new this pass
  │  packages/domain-packs/*/test/  ✓ 8 tests, scorecard fixtures       │ ← new this pass
  │  packages/engines/*/test/       ✓ 10 tests, collect()/evaluate()    │ ← new this pass
  │  src/config.ts                  ✓ 2 tests, no DB gate               │
  │  detectEntityType, Scorer fixtures (test/commands.test.ts)  ✓ 4     │
  └─────────────────────────────────────────────────────────────────────┘
  ┌─ Integration (DATABASE_URL-gated) ────────────────────────────────┐
  │  src/migrate.ts (runAllMigrations, now 2 files)  ✓ idempotent      │
  │  src/pg-vector-store.ts         ✓ upsert+rank, dimension-mismatch  │
  │  src/pg-journal-store.ts        ✓ create/listDue/snooze/resolve    │ ← new this pass
  │  src/profile.ts                 ✓ stored-or-empty                  │
  │  src/runtime.ts                 ✓ documents row + chunks           │
  │  src/supabase-trace-sink.ts     ✓ all 6 events + ordering          │
  │  amazon/rss/trends tools, db-sources.ts  ✓ (test/*-tool.test.ts)   │ ← new this pass
  └─────────────────────────────────────────────────────────────────────┘
  ┌─ Scripted state machine (in-process, stubbed session, no I/O) ────┐
  │  src/cli/research-flow.ts       ✓ 7 tests — predict/reveal/promote │ ← new this pass
  │  src/cli/review-flow.ts         ✓ 6 tests — keep/snooze/resolve    │ ← new this pass
  └─────────────────────────────────────────────────────────────────────┘
  ┌─ e2e (gated, narrow) ──────────────────────────────────────────────┐
  │  test/gemma.live.test.ts        ✓ 1 test, SKIP-gated by default    │ ← new this pass
  └─────────────────────────────────────────────────────────────────────┘
  ┌─ UNTESTED — the orchestration + UI layer ───────────────────────────┐
  │  ★ src/session.ts (883 lines) ✗  15 public methods, ALL untested   │ ← highest leverage,
  │                                    grown from ~7 methods last pass  │   WORSE than last pass
  │    src/cli/chat.tsx (474 lines) ✗ OpenTUI UI + both flow controllers│
  │    src/db.ts                    ✗ trivial Pool factory (low value) │
  │    src/cli/index-cmd.ts         ✗ thin CLI wrapper                 │
  │    src/cli/eval-cmd.ts          ✗ EVAL script, not a unit test     │ → study-ai-engineering
  └─────────────────────────────────────────────────────────────────────┘

  data flow: chat.tsx → session.ts → {pg-vector-store, pg-journal-store,
             profile, trace-sink, aptkit agent, MarketResearchEngine,
             InvestingEngine, research-flow, review-flow}.
             The LEAVES are now almost entirely tested, including the
             new engines and the new flows. The TRUNK that wires them
             (session.ts) still has zero tests, and it's a bigger trunk
             than it was last pass.
```

The shape to notice, sharper than last pass: testing kept going **bottom-up**, and it went a lot further down and sideways — the whole capabilities/engines/connectors layer that didn't exist (or wasn't audited) at the last sync is now solidly covered, and the two new interactive flows escaped the "hard to test" fate that usually befalls conversational CLI code by being extracted as pure state machines before the tests were written. None of that closed the one gap that matters most: `session.ts` is where all of these tested leaves get composed into an actual chat turn, and it has grown, not shrunk, since the last pass.

---

## The three highest-leverage gaps

Ranked by how many real regressions a test would catch.

### 1. `src/session.ts` — 15 untested methods, and the gap widened (worst, unchanged rank, worse evidence)

`ChatSession`'s interface (`session.ts:103-125`) now spans `ask`, `analyze`, `evalInvesting`, `evalResearch`, `suggestResearchTopics`, `connectorStatus`, `researchCollect`, `researchEvaluate`, `saveHypothesis`, `saveDecision`, `dueReviewCount`, `listDueReviews`, `snoozeReview`, `resolveReview`, `close` — roughly double the surface area from the last audit. Every one of `research-flow.test.ts`'s and `review-flow.test.ts`'s tests is only possible *because* they stub this entire interface rather than exercise the real implementation (`makeStubSession()` in each file). That's the right move for testing the flows in isolation — but it means nothing in this repo proves the real `session.ts` implementations of `researchCollect`, `researchEvaluate`, `saveDecision`, `listDueReviews`, `snoozeReview`, and `resolveReview` actually honor the contract the flow tests assume. The original invariants from the last pass — persist-then-answer ordering, `trace.flush()` before return, the swallowed memory-write `catch` — are all still real, still untested, and now joined by a second, larger set: does `researchCollect` actually call the right connectors in the right order? Does `saveDecision` actually thread the prediction and assessment through to `PgJournalStore.create` correctly? This is deterministic and testable today with the exact injected-fake discipline `07-scripted-multi-turn-flow-test.md` already demonstrates one layer up — it just hasn't been pointed at `session.ts` itself yet.

### 2. `src/cli/chat.tsx` — grown to 474 lines, two untested bug fixes prove the cost

The component now wires both flow controllers, four slash-command handlers (`/investing`, `/eval`, `/research`, `/review`), the `busy`/`activeFlow` re-entrancy guard, and the error-turn catch. Commit `41ecce8` ("fix: close 5 integration-seam bugs from whole-branch review") is the clearest evidence this gap is real: of its five fixes, the two that touched already-tested, already-decoupled modules (the market-research zero-findings guard, the `InMemoryJournalStore` scoping leak) shipped with regression tests in the same commit; the two that touched `chat.tsx` (the empty-input-when-flow-active guard, the unguarded `dueReviewCount()` startup call) did not — because the module's top-level `await createChatSession()` (`chat.tsx:462`) makes it untestable without a real session, the same design-pressure finding from the last pass, unchanged. See `audit.md` lens 3 for the full account.

### 3. The whole suite is now eight commands, and none of them compose

Last pass this was "the DB suite is green-by-skip in CI." It's grown into something more structural: there are now **eight independent `npm test` invocations** (root, plus `kernel`, `capabilities`, `connectors`, `domain-pack-investing`, `domain-pack-market-research`, `engine-investing`, `engine-market-research`) — nothing in the repo runs all of them with one command, and there is still no `.github/workflows` directory. A CI job that (reasonably, naively) ran `npm test` at the root would exercise roughly a quarter of the tests that exist in this repo and silently skip the rest, including all of `packages/kernel`'s 65 tests. The fix isn't complicated — a root script that loops every workspace's `test` command, or a CI matrix job per package — but it doesn't exist yet, and the gap widens every time a new package is added.

---

## One-line verdict per lens

| # | Lens | Verdict |
|---|------|---------|
| 1 | what-is-tested-and-what-isnt | The whole package layer (139 tests, 6 packages) is now covered and wasn't audited before; `session.ts` grew and stayed at zero. |
| 2 | test-design-and-levels | A real unit layer now dominates the monorepo (126 tests, no DB/LLM); integration and one gated e2e probe round it out. |
| 3 | tests-as-design-pressure | The flow objects escaped the untestable-bootstrap trap by extraction; `chat.tsx` itself didn't, and two unregression-tested `41ecce8` fixes prove the cost. |
| 4 | determinism-isolation-and-flakiness | Still strong; a third isolation mechanism (no shared state to begin with) joins DB-cleanup and the fake embedder. |
| 5 | edge-cases-and-error-paths | Two real regression tests landed (zero-findings guard, journal scoping leak); the swallowed catch and both migration rollback paths remain untested. |
| 6 | testing-ai-features | The deterministic-harness-over-a-stub-model pattern spread to Teacher and both engines, not just the trace sink; `session.ts` is where they're composed and untested. |
| 7 | testing-red-flags-audit | 1 flag firing (worse), 1 partial (improved); "green-by-skip" changed shape into "no single command runs the whole suite." |

Full walk with `file:line` grounding in **`audit.md`**.

## Pattern files

- `01-env-gated-integration-tests.md` — the DB-gate pattern
- `02-fake-embedder-injection.md` — deterministic substitute for Ollama
- `03-contract-parity-test.md` — `PgVectorStore` upsert-and-rank, plus a second instance (`JournalStore`) that shows what happens when the "shared suite" discipline isn't followed
- `04-idempotent-migration-test.md` — run-twice schema test, now against a multi-file migration runner
- `05-full-signal-trajectory-assertion.md` — trace sink with synthetic events
- `06-fixture-based-scorer-accuracy.md` — golden-fixture eval for deterministic functions
- `07-scripted-multi-turn-flow-test.md` — interactive `/research`/`/review` conversations tested as pure state machines (new this pass)
