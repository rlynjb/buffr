# Pass 1 — the 7-lens testing audit

Each lens below is one structured read of the `buffr-laptop` suite, grounded in `file:line` or marked `not yet exercised` honestly. When a finding is big enough to earn its own deep walk, the lens cross-links to the Pass 2 pattern file rather than restating it.

Suite snapshot: **9 tests / 6 files / 9 pass.** Runner: `node --test --test-concurrency=1 dist/test/*.test.js` after a `tsc` build (`package.json:7`). 7 of 9 tests gate on `DATABASE_URL` and skip when unset.

---

## Lens 1 — what is tested, and what isn't

The coverage map is in `00-overview.md`. The structural finding: **testing went bottom-up, and stopped before it reached the trunk.**

What's tested, and it's the right thing per file:

- `loadConfig` (`test/config.test.ts:5-20`) — defaults and overrides, the only test that runs with no database.
- `runMigration` (`test/migrate.test.ts:16-27`) — idempotent schema creation → see `04-idempotent-migration-test.md`.
- `PgVectorStore` (`test/pg-vector-store.test.ts:30-46`) — upsert-and-rank + dimension guard → see `03-contract-parity-test.md`.
- `loadProfile` (`test/profile.test.ts:21-25`) — stored content or empty string.
- `indexDocumentRow` (`test/runtime.test.ts:31-40`) — writes a `documents` row then its chunks, via the fake embedder → see `02-fake-embedder-injection.md`.
- `SupabaseTraceSink` (`test/supabase-trace-sink.test.ts:23-67`) — all 6 event types + ordering → see `05-full-signal-trajectory-assertion.md`.

What isn't, ranked by risk:

- **`src/session.ts` — the orchestrator, zero tests.** `createChatSession()` wires the pool, store, pipeline, tool, model, memory, trace, and agent (`session.ts:34-57`); `ask()` runs the persist-then-answer-then-flush-then-remember sequence (`session.ts:60-71`). This is the most complex code in the repo and the least tested. **Red flag firing:** the most important code is the least covered.
- **`src/cli/chat.tsx` — the Ink UI, zero tests.** Real branches: the `busy` re-entrancy guard (`chat.tsx:17`), `/exit` close (`chat.tsx:18-22`), the error-turn `catch` (`chat.tsx:30-32`).
- `src/db.ts` — a 2-line `Pool` factory; too thin to earn a test.
- `src/cli/index-cmd.ts` — a thin file-reading CLI over the tested `indexDocumentRow`.
- `src/cli/eval-cmd.ts` — **not a unit test at all.** It's the eval/reporting script (precision@k, recall@k over `eval/queries.json`, `eval-cmd.ts:22-33`). It prints, never asserts → that's the *eval* half of the seam, cross-linked to `study-ai-engineering`.

---

## Lens 2 — test design and levels

The pyramid as-built is **upside-down-but-correct for this repo**: almost everything is an integration test against a real Postgres, with one true unit test on top. Normally an integration-heavy suite is a smell (slow, flaky). Here it's the right call — the modules under test are *thin wrappers over SQL*, so a unit test that mocked the database would test the mock, not the behavior. There is nothing to unit-test in `PgVectorStore.search` except "does this SQL return the right ranking," and that question only has a real answer against pgvector.

```
  The pyramid as-built

         ┌────────────────────────┐
   unit  │ loadConfig (always run)│   1 file, pure, no DB
         └────────────────────────┘
       ┌──────────────────────────────┐
  integ│ migrate · pg-vector · profile │   5 files, real Postgres,
       │ runtime · trace-sink          │   DATABASE_URL-gated
       └──────────────────────────────┘
              ┌──────────────┐
        e2e   │  none        │   no test drives chat.tsx → session →
              └──────────────┘   live Gemma end to end
```

What the design gets right:

- **No over-mocking.** The DB tests use the real database; the one place a dependency is faked is the *embedder*, and that's faked because it's a network call to Ollama, not because the code is hard to reach. That fake is a deterministic substitute, not a mock that asserts on calls → see `02-fake-embedder-injection.md`.
- **The embedder is injected, not imported.** `createRetrievalPipeline({ embedder, store })` takes the embedder as a parameter (`runtime.test.ts:33`), so the test swaps it without touching production code. That's a clean seam.

What's missing at the levels:

- **No e2e.** Nothing exercises `chat.tsx → session.ask() → Gemma → answer` against a live model. Honest `not yet exercised` — and arguably correct to skip, since a live-Gemma e2e is slow and non-deterministic. The deterministic substitute (test `session.ts` with a fake agent) is the higher-value move and is also absent.
- **The integration tests are also the unit tests for their modules.** There's no separate fast unit layer for `PgVectorStore` logic like `toVectorLiteral` (`pg-vector-store.ts:15-17`) — a pure function that could be unit-tested with no DB at all but isn't.

---

## Lens 3 — tests as design pressure

Where is code hard to test *because* the design is tangled? One clear spot, and it's a design finding, not a testing one:

**`src/cli/chat.tsx:62-63` runs `await createChatSession()` and `render(...)` at module top level.** Importing the module to test the `Chat` component fires a real session — a real pool, a real Ollama embedder, a real `loadProfile` query. The component and the bootstrap are fused. The fix is structural: separate the `Chat` component (testable with `ink-testing-library` + an injected fake session) from the `main()` that builds the real one. That's a deep-vs-shallow-module observation → **cross-link to `study-software-design`**; this guide only notes that the fusion is *why* the UI is untested.

Everywhere else the design *helps* the tests:

- `loadConfig(env)` takes env as a parameter (`config.ts:9`) — pure function, trivially testable, and the test passes a fixture `{}` (`config.test.ts:7`). This is the model the rest of the repo follows.
- `PgVectorStore`, `indexDocumentRow`, `SupabaseTraceSink`, `loadProfile` all take their `pool` as a constructor/parameter dependency. None reaches for a global. That dependency-injection discipline is exactly what makes the integration tests as short as they are.

So the design-pressure verdict is: **one untestable seam (`chat.tsx` bootstrap), everything else is injectable.** The repo already knows the pattern; it just didn't apply it to the UI entry point.

---

## Lens 4 — determinism, isolation, and flakiness

This is the suite's strongest lens. Four mechanisms keep it deterministic:

- **`--test-concurrency=1`** (`package.json:7`) — tests run serially. Since multiple DB tests share one Postgres and clean by `app_id`, serial execution removes cross-test interference on shared rows.
- **Per-test cleanup keyed by `app_id = 'test'`.** `beforeEach` deletes the test rows before each test (`pg-vector-store.test.ts:19-21`, `runtime.test.ts:25-28`, `supabase-trace-sink.test.ts:18-20`). State doesn't leak between tests, and the production `app_id` (`'laptop'`) is never touched. This is the isolation backbone.
- **The fake embedder removes the one non-deterministic dependency.** Real embeddings come from a network call to Ollama; the fake returns a fixed 768-dim vector with no I/O (`runtime.test.ts:14-17`) → see `02-fake-embedder-injection.md`.
- **The trace-sink test pins event order with explicit timestamps.** Instead of trusting insert race order, it emits events with hand-set ISO timestamps and asserts `created_at` ordering equals emit order (`supabase-trace-sink.test.ts:41-66`). That converts a potential flake (concurrent flush inserts racing) into a deterministic assertion → see `05-full-signal-trajectory-assertion.md`.

Flakiness sources checked and **not** found: no `Date.now()` / `Math.random()` in test assertions, no `setTimeout`-based waits, no dependence on test *file* order (each file owns its cleanup). The one ordering dependency that *could* bite — concurrent flush inserts — is the exact thing the timestamp assertion defends against.

The honest gap: **`PgVectorStore.search` ranking is asserted as `>=`, not exact.** `assert.ok(hits[0].score >= hits[1].score)` (`pg-vector-store.test.ts:39`) tolerates the HNSW index returning approximate neighbors. That's correct — HNSW is approximate by design, so an exact-score assertion would be the flaky one. Worth knowing this is a deliberate loosening, not a sloppy one.

---

## Lens 5 — edge cases and error paths

Thin. The happy path is covered everywhere; the error branches mostly aren't.

What IS tested on the unhappy path:

- **Dimension mismatch throws.** Both `upsert` and `search` reject a wrong-length vector (`pg-vector-store.test.ts:42-46`), matching the must-not-change constraint that a 768-dim mismatch must throw, never silently truncate (`assertDim`, `pg-vector-store.ts:32-36`). This is the one error branch with a real test, and it's the right one to have.
- **Empty profile returns `''`.** `loadProfile` on a missing row returns the empty string, not `undefined` or a throw (`profile.test.ts:22`). A boundary (no rows) is checked.

What ISN'T:

- **The swallowed memory-write `catch` (`session.ts:64-69`).** A `try/catch` that deliberately eats the error so a memory failure doesn't lose the answer. Zero tests assert that a throwing `memory.remember()` still returns the answer — and a swallow with no test is exactly the branch that silently starts eating *real* errors. **Red flag firing:** zero tests on a deliberately-swallowed error branch.
- **The migration rollback path (`migrate.ts:13-16`).** `runMigration` rolls back and rethrows on a bad SQL script. Only the success path is tested (`migrate.test.ts`); a malformed-SQL test would pin the rollback.
- **The `upsert` / `search` transaction rollback (`pg-vector-store.ts:59-64`).** Same shape — the rollback-on-error branch is unexercised.
- **`chat.tsx` error turn (`chat.tsx:30-32`).** An `ask()` rejection should render `error: <message>` as a buffr turn. No test.

No property-based testing anywhere — reasonable for this repo's size, but `toVectorLiteral` round-tripping or chunk-id parsing would be natural property targets if the suite grew.

---

## Lens 6 — testing AI features

This is the seam the whole guide is organized around, and **the repo handles it correctly.**

The agent loop (`RagQueryAgent.answer()`, called in `session.ts:62`) is non-deterministic — it calls Gemma. You can't `assert.equal` on a Gemma answer. So the testable surface is everything *around* the model: prompt assembly, tool dispatch, output persistence. The repo tests the persistence boundary the right way:

**The trace sink is tested by feeding it synthetic `CapabilityEvent`s, not by running the agent.** `supabase-trace-sink.test.ts:41-45` hand-constructs one event of each type (`tool_call_start`, `tool_call_end`, `model_usage`, `warning`, `error`) and asserts they all land in `agents.messages` with the full signal captured — args, `durationMs`, `error`, token sum (`123`), and emit order. That's the textbook move: **a deterministic harness wrapping a probabilistic core.** The core (Gemma) is replaced by a known event stream; everything downstream of it is asserted exactly.

```
  The AI-testing seam in this repo

  ┌─ probabilistic core (NOT tested here) ─┐
  │  RagQueryAgent.answer() → Gemma         │   → eval seam, study-ai-engineering
  └──────────────────┬──────────────────────┘
                     │ emits CapabilityEvent[]
   test replaces ────┤  (the test injects synthetic events here)
                     ▼
  ┌─ deterministic harness (tested here) ──┐
  │  SupabaseTraceSink.emit → persistMessage│   assert.equal on every field
  │  → agents.messages rows                 │   ← this guide
  └──────────────────────────────────────────┘
```

Where it hands off: the *quality* of retrieval — does the right chunk come back for a query — is measured by `eval-cmd.ts` (precision@k / recall@k over `eval/queries.json`), which **prints and never asserts**. That's correct: retrieval quality is a "good enough / didn't regress" question, which is evaluation, not testing → `study-ai-engineering`.

The gap on this lens: the *other* deterministic boundaries around the model aren't tested. **Prompt assembly** — `loadProfile` feeds the system prompt (`session.ts:47,57`), but no test asserts the profile actually reaches the agent. **Tool dispatch** — `createSearchKnowledgeBaseTool` is wired (`session.ts:43-44`) but no test asserts the tool handler is registered and callable. Both are deterministic and testable; both run through the untested `session.ts`.

---

## Lens 7 — testing red-flags audit (capstone)

The consolidated checklist, marked against this repo.

| Red flag | Firing? | Evidence |
|----------|:---:|----------|
| Most important / most complex code is least tested | **YES** | `session.ts` orchestrator has 0 tests; leaves all have tests (lens 1). |
| Heavy mocking that tests the mock, not the code | no | Only the embedder is faked, as a deterministic substitute, not an assertion target (lens 2). |
| Inverted pyramid (all slow/flaky e2e) | no | Integration-heavy but deliberate; no flaky e2e (lens 2). |
| Flaky: passes/fails on rerun, no code change | no | `--test-concurrency=1`, `app_id` cleanup, fake embedder, timestamp-pinned ordering (lens 4). |
| Tests require a specific run order | no | Each file owns its `beforeEach` cleanup (lens 4). |
| Zero tests on error/exception branches | **PARTIAL** | Dimension-mismatch tested; swallowed `catch` and rollback paths not (lens 5). |
| AI feature with no test at the deterministic boundary | no | Trace-sink boundary tested with synthetic events (lens 6). |
| Green-by-skip: suite passes while testing almost nothing | **YES** | 7/9 tests skip without `DATABASE_URL`; no CI provisions a DB (lens 1, `00-overview` gap 3). |

**2 firing, 1 partial.** The two real ones are the same story from two sides: the orchestration trunk is untested, and the integration tests that *do* exist don't run in CI. Both are fixable without rearchitecting anything — one test file for `session.ts` with injected fakes, and one CI job with a pgvector service container.

The honest "not yet exercised" list, stated plainly:

- **CI** — green-by-skip without `DATABASE_URL`; no workflow provisions Postgres.
- **e2e of chat against live Gemma** — no test drives the Ink UI through a real model turn.
- **error-branch coverage** — swallowed memory-write, migration rollback, transaction rollback, the chat error turn.
