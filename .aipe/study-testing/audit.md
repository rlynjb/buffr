# Pass 1 — The Testing Audit · buffr-laptop

Seven lenses. Each is one x-ray of the same suite. The verdict runs through all
of them: **the persistence layer is well-tested and honest; the product layer
(`session.ts`, `chat.tsx`) is untested, and that's where the bugs that reach a
user will live.**

Suite at a glance, measured — not estimated:

```
  node --test --test-concurrency=1 dist/test/*.test.js

  file                          tests   touches DB?   runs when DATABASE_URL unset
  ────────────────────────────  ─────   ───────────   ───────────────────────────
  config.test.ts                  2     no            RUNS (pure function)
  migrate.test.ts                 1     yes           SKIPS
  pg-vector-store.test.ts         2     yes           SKIPS
  profile.test.ts                 1     yes           SKIPS
  runtime.test.ts                 1     yes           SKIPS
  supabase-trace-sink.test.ts     2     yes           SKIPS
  ────────────────────────────  ─────
  total                           9     8 of 9 gate on DATABASE_URL
```

Read that table twice. **On a machine with no `DATABASE_URL`, eight of nine
tests skip and the suite reports green.** That single fact reframes the whole
audit — see lens 4.

---

## 1. What is tested, and what isn't (the risk map)

Not the percentage — the *risk*. Rank the critical paths by "what happens to a
user if this breaks," then ask which ones a test catches.

```
  Critical path                         broken → user sees      test catches it?
  ───────────────────────────────────   ────────────────────    ─────────────────
  config defaults (appId/schema/host)   wrong DB / wrong app    YES  config.test
  pgvector ranking (right chunk on top) wrong / no answer       YES  pg-vector-store
  768-dim guard (no silent truncation)  corrupt embeddings      YES  pg-vector-store
  schema migration (idempotent)         broken DB on deploy     YES  migrate.test
  profile injection (system prompt)     ignores user prefs      YES  profile.test
  document indexing (doc row + chunks)  nothing to retrieve     YES  runtime.test
  trajectory capture (all 6 events)     blind to what happened  YES  trace-sink
  ───────────────────────────────────   ────────────────────    ─────────────────
  per-turn ordering (persist→answer→    lost turn / wrong       NO   ★ session.ts
    flush→remember)                       replay order            ZERO tests
  memory-write swallow (best-effort)    silent memory loss      NO   ★ session.ts
  chat onSubmit (busy-gate, /exit,      frozen UI / data loss   NO   ★ chat.tsx
    error→turn)                                                   ZERO tests
```

The top block is the persistence substrate, and it's genuinely well-covered —
each test plants a known input and asserts a known output. The bottom block is
the **conversation itself**, and it has no tests at all.

**The red flag this lens looks for — "the most important code is the least
tested" — is present, and it's the headline finding.** `src/session.ts:60-71`
is the most behaviorally dense function in the repo. Its `ask()` does four
ordered things:

```
  1. persistMessage(... 'user', question)   ← write the turn FIRST
  2. answer = agent.answer(question)         ← then run the model
  3. trace.flush()                           ← then drain queued trace writes
  4. try { memory.remember(...) } catch {}   ← then best-effort remember
```

Three properties here are assertable and untested:
- **Order**: the user turn is persisted *before* the agent runs, so a crash
  mid-answer still leaves the question on disk. Nothing asserts this ordering.
- **The swallow** (`session.ts:66-69`): a memory-write failure must not lose the
  answer. There is no test that injects a throwing `memory.remember` and asserts
  `ask()` still returns the answer. This is exactly the kind of error branch
  that rots unnoticed — see lens 5.
- **flush-before-return**: `trace.flush()` is awaited before `ask()` resolves,
  so by the time the UI renders the answer the trajectory is durable. Untested.

`src/cli/chat.tsx` is the only interface buffr has (`npm run chat`), and the
`onSubmit` handler (`chat.tsx:15-35`) carries real logic: the `busy` re-entrancy
gate (`if (busy) return`), the `/exit`//`/quit` branch that closes the pool, and
the `catch` that turns an `ask()` rejection into a `buffr` turn instead of an
unhandled rejection. None of it is tested.

→ For *why* these two files resist testing, see lens 3 and `study-software-design`.

## 2. Test design and levels (the pyramid as-built)

buffr's pyramid is unusual and, mostly, correct for what it is:

```
  Standard pyramid (what books draw)     buffr's actual shape
  ──────────────────────────────────     ────────────────────
        /\   e2e (few)                    none           ← chat.tsx untested
       /  \                               ────────────
      /    \  integration                 ███████████    ← 8 of 9 tests
     /      \                             real Postgres, no mocks
    /________\ unit (many)                ██             ← config only (1 file)
```

This is an **integration-heavy, mock-free** suite, and that's the right call for
this codebase. Here's the reasoning: the load-bearing logic in
`pg-vector-store.ts` *is* the SQL — the cosine-distance ranking
(`1 - (embedding <=> $1::vector)`, line 75), the `on conflict do update` upsert
(line 50), the meta-shape rebuild (lines 80-84). Mock the database and you'd be
asserting that your mock returns what you told it to. The test would prove
nothing. So buffr runs the real query against real pgvector and asserts the
*planted* chunk ranks first (`pg-vector-store.test.ts:30-40`). That's a test of
the code, not the mock.

**The one place mock-free bites:** because there are no unit-level seams, the
moment you want to test `session.ts` without a live Postgres + Ollama you have
nothing to inject. The `fakeEmbedder` trick (`runtime.test.ts:14-17`) proves the
*pattern* works — swap the probabilistic dependency for a deterministic stub —
but `session.ts` hard-constructs its own pool, embedder, store, and agent inside
`createChatSession()` (`session.ts:39-57`), so there's no seam to reach. That's a
design constraint, not a test-design failure → lens 3.

No inverted pyramid, no flaky e2e, no over-mocking. The design smell is the
*absence* of a layer, not a bad one.

## 3. Tests as design pressure (untestable = a design smell)

This is where testing and design meet. Two files are untested **because they're
hard to test**, and the hardness is a design signal, not a testing gap.

**`chat.tsx:62-63` — top-level await + immediate render.**

```
  const session = await createChatSession();   // module side-effect: opens a pool
  render(<Chat session={session} />);          // module side-effect: mounts Ink
```

Importing this module *runs* it — it connects to Postgres and renders a TUI.
There is no exported function, no seam, nothing a test can call. The `Chat`
component itself takes `session` as a prop (good — that's injectable), but it's
never exported, so a test can't mount it with a fake session.

→ **The fix is a one-line design change**: export `Chat`, and move the
`createChatSession()` + `render()` into an `if (import.meta.url === ...)` main
guard, exactly like `migrate.ts:23` already does. Then a test mounts `<Chat
session={fakeSession} />` with `ink-testing-library`, types a question, and
asserts the `busy` spinner shows and the answer turn appears. **This is a
software-design finding — deep, testable modules — cross-linked to
`study-software-design`.** The testing guide names the smell; the design guide
owns the refactor.

**`session.ts:34-57` — `createChatSession()` constructs its own world.**

It news up the pool, embedder, store, pipeline, tools, model, memory, and agent
internally. To test `ask()`'s ordering you'd need real versions of all of them.
There's no parameter to inject a fake agent or a throwing memory.

→ The buildable target: split `createChatSession()` (the wiring) from a pure
`runTurn({ persist, agent, trace, memory }, question)` (the ordering logic).
Then `runTurn` is unit-testable with four stubs — assert persist-before-answer,
assert flush-before-return, assert a throwing `memory.remember` is swallowed and
the answer still returns. The orchestration is the riskiest code in the repo and
it's untestable *because* the wiring and the logic are fused.

The contrast that makes the point: `config.ts:9` is `loadConfig(env)` — pure,
env-in/config-out, explicitly documented as "tests pass a fixture." It's the
most trivial code in the repo and the easiest to test. `session.ts` is the most
important and the hardest. **Testability tracked design quality exactly.**

## 4. Determinism, isolation, and flakiness

This is buffr's strongest lens. The suite is genuinely deterministic and
well-isolated, with one structural caveat that isn't flakiness but *is* a
correctness blind spot.

**Determinism — three sources of non-determinism, all handled:**

- **Network/model**: the obvious flake source in an AI repo is calling Ollama.
  `runtime.test.ts` never does — it injects a `fakeEmbedder` returning a fixed
  768-vector with `v[1]=1` (lines 14-17). Same input, same output, every run.
  → `02-fake-embedder-injection.md`.
- **Time/ordering**: the trace test could have raced — `emit()` queues writes
  and `flush()` awaits them concurrently (`supabase-trace-sink.ts:91-93`), so
  insert order isn't guaranteed. The test defends against this by feeding
  explicit ISO timestamps and asserting `order by created_at` replays them in
  emit order (`supabase-trace-sink.test.ts:41-66`). The non-determinism is
  designed out, then asserted. → `05-full-signal-trajectory-test.md`.
- **Shared mutable state**: every DB test cleans by `app_id = 'test'` in
  `beforeEach` (`pg-vector-store.test.ts:19-21`, `runtime.test.ts:25-28`) or
  `before` (`profile.test.ts:17`), so a leftover row from a previous run can't
  flip a result.

**Isolation — `--test-concurrency=1` is load-bearing, not cosmetic.** Every DB
test runs against the *same* `reindb`/`agents` schema. Run two files in parallel
and `runtime.test`'s `delete from agents.chunks where app_id='test'` races
`pg-vector-store.test`'s upsert of `app_id='test'` rows. The `package.json` test
script serializes files (`--test-concurrency=1`) so the shared database behaves
like a single-threaded resource. **The isolation is `app_id` scoping *plus*
serial execution — drop either and the suite goes flaky.** Worth knowing that
`app_id='test'` is the convention but it's enforced by discipline, not by the
schema; a test that forgets the `where` clause would wipe real data.

**The caveat that isn't flakiness — green-by-skip.** `describe(..., { skip: url
? false : 'set DATABASE_URL to run' })` (every DB test) means: no
`DATABASE_URL`, the suite passes with eight tests skipped and one run. **This is
not flaky — it's worse, it's silently incomplete.** A CI runner without a
Postgres service reports green while testing ~one pure function. The honest
status is in `01-env-gated-integration-tests.md`: the gate is the right
*mechanism* (don't fail a contributor who has no DB), but green-on-skip is a
false signal. The fix is a CI job that provisions Postgres and asserts the
skipped count is zero — otherwise "tests pass" means almost nothing.

## 5. Edge cases and error paths

The happy path is tested; the error branches mostly aren't. Standard, but two of
the gaps are sharp.

**Covered edge cases (genuinely good ones):**
- **Dimension mismatch throws, both directions.** `pg-vector-store.test.ts:42-46`
  asserts a 3-element vector rejects on *both* `upsert` and `search` with
  `/dimension/`. This directly defends the must-not-change constraint "a
  mismatch must throw, never silently truncate" (context.md). Real boundary,
  real assertion.
- **Empty/absent profile.** `profile.test.ts:22` asserts `loadProfile` returns
  `''` (not `undefined`, not a throw) when no row exists — the `?? ''` in
  `profile.ts:7` made concrete.
- **Idempotent re-run.** `migrate.test.ts:18` runs the migration twice; the
  second run is the edge case (does `create table if not exists` +
  `drop constraint if exists` actually no-op?). → `04-idempotent-migration-test.md`.
- **Every event variant.** The trace test emits one of all six `CapabilityEvent`
  types including `warning` and `error` (`supabase-trace-sink.test.ts:41-45`) —
  the branches that were "previously dropped on the floor" per
  `supabase-trace-sink.ts:48`.

**Uncovered error branches — ranked worst-first:**

```
  branch                                        where                  risk
  ────────────────────────────────────────────  ─────────────────────  ──────
  memory.remember throws → swallowed, answer     session.ts:66-69       HIGH
    still returned                                                       
  agent.answer rejects → onSubmit catch →        chat.tsx:30-32         MED
    "error: <msg>" turn, busy released                                  
  migration mid-script failure → rollback        migrate.ts:14-16       MED
  pgvector upsert mid-batch failure → rollback   pg-vector-store.ts:59  LOW
```

The top one is the most important untested branch in the repo. The comment at
`session.ts:67` states the contract — *"swallow: memory is best-effort, the turn
already succeeded"* — and **nothing proves it holds.** If a future refactor moves
`return answer` inside the `try`, a memory failure starts eating answers and no
test goes red. That's a one-test fix (inject a throwing memory, assert the answer
returns) blocked only by the wiring/logic fusion from lens 3.

The `migrate.ts` rollback (lines 11-19) wraps the whole script in one
transaction and rolls back on any failure — untested, but lower risk because
`begin`/`commit`/`rollback` is a well-worn pg idiom and the happy-path idempotent
test exercises the commit branch.

No property-based testing anywhere. For this repo that's fine — the invariants
(dimension = 768, ranking order) are point-tested, and there's no
combinatorial input space crying out for a generator. Not a gap, just a "not
exercised."

## 6. Testing AI features (the deterministic-harness-around-a-probabilistic-core seam)

This is the lens that matters most for where Rein is headed, so read it closely.
buffr is an AI app, and the question is: **does it put a deterministic test
boundary around the non-deterministic core, or does it leave the AI seam
untested?**

The answer is split. buffr tests the seam in exactly one place and leaves the
two highest-value AI seams untested.

```
  The AI feature, by testable boundary

  ┌─ deterministic, testable (the harness) ──────────────────────┐
  │  embedding INJECTION   runtime.test injects fakeEmbedder ✓    │
  │  retrieval RANKING     pg-vector-store asserts planted top ✓  │
  │  trajectory CAPTURE    trace-sink asserts all 6 events ✓      │
  │  tool DISPATCH         search_knowledge_base wiring   ✗ none  │
  │  answer ORCHESTRATION  session.ask ordering           ✗ none  │
  └──────────────────────────────────────────────────────────────┘
  ┌─ probabilistic, evaluated NOT tested (→ ai-engineering) ──────┐
  │  the model's actual answer text   eval-cmd precision@k        │
  └──────────────────────────────────────────────────────────────┘
```

**What buffr does right at the seam:** the `fakeEmbedder` in `runtime.test.ts`
is the textbook move. The real `OllamaEmbeddingProvider` is non-deterministic and
needs a running model; the test swaps in an `EmbeddingProvider` whose `embed()`
returns a fixed vector (lines 14-17). Now `indexDocumentRow` → `pipeline.index`
→ `store.upsert` is a fully deterministic chain you can assert exactly. The
**probabilistic core (the embedding model) is replaced by a deterministic stub,
and the deterministic plumbing around it is tested.** That is the entire pattern
for testing AI features, and buffr exercises it. → `02-fake-embedder-injection.md`.

**Where it stops short — the red flag:** "an LLM feature with no test at the
boundary (prompt assembly, tool dispatch, output parsing) — all of which ARE
deterministic and testable." buffr has two such boundaries, both untested:

- **Tool dispatch.** `session.ts:43-44` builds a `search_knowledge_base` tool and
  registers it in an `InMemoryToolRegistry`. Whether the registry routes a
  `search_knowledge_base` call to the right handler with the right args is
  *deterministic* — and untested here (it may be tested upstream in aptkit;
  buffr doesn't assert its own wiring).
- **Answer orchestration.** `session.ask()` is the prompt-assembly + run +
  persist boundary. With a fake agent it's fully deterministic and fully
  untestable today (lens 3).

**The handoff to study-ai-engineering is clean and correct.** The model's actual
answer text is non-deterministic — you can't `assert.equal` it. So buffr doesn't
try; it measures it with `eval-cmd.ts`'s `scorePrecisionAtK` / `scoreRecallAtK`
over the labeled `eval/queries.json` (lines 22-33). That's an *eval*, not a test,
and it belongs in `study-ai-engineering`. buffr drew the deterministic/eval line
in the right place — it just hasn't filled in the deterministic side around the
orchestrator yet.

## 7. Testing red-flags audit (the capstone checklist)

Consolidated, marked against this repo. ✓ = clean, ✗ = present, ~ = partial.

```
  red flag                                              buffr    where
  ───────────────────────────────────────────────────  ─────    ─────────────────
  most important code is least tested                   ✗ PRESENT session.ts, chat.tsx
  heavy mocking — testing the mock, not the code        ✓ clean   mock-free by design
  inverted pyramid (all slow flaky e2e)                 ✓ clean   no e2e at all
  tests depend on time / network / ordering             ✓ clean   timestamps + fakeEmbedder
  tests must run in a specific order                    ~ partial --test-concurrency=1 needed
  passes/fails on rerun, no code change (flaky)         ✓ clean   app_id cleanup + serial
  zero tests on error/exception branches                ✗ PRESENT memory swallow, onSubmit catch
  LLM feature untested at its deterministic boundary    ✗ PRESENT tool dispatch, orchestration
  suite green while testing almost nothing              ✗ PRESENT green-by-skip without DB
  no edge-case / boundary coverage                      ✓ clean   dimension, empty profile, idempotent
```

Four red flags present, and they cluster. Three of them — least-tested-most-
important, untested error branches, untested AI boundary — are the *same finding*
seen through three lenses: **`session.ts` and `chat.tsx` have no tests.** Close
that one gap (via the lens-3 design split) and three of the four flags clear at
once. The fourth — green-by-skip — is a CI fix, not a code fix: provision
Postgres in CI and fail the build if the skipped-test count isn't zero.

**The single highest-leverage move:** export `Chat` + main-guard `chat.tsx`, and
split `runTurn` out of `createChatSession`. That one refactor makes the riskiest
code in the repo testable, and the tests that follow (ordering, the swallow, the
busy-gate, the error turn) retire the headline finding of this entire audit.

---

### Honest "not yet exercised"

- **CI gate** — no CI config provisions a database, so the suite is green-by-skip
  on any machine without `DATABASE_URL`. Lens 4.
- **End-to-end chat against live Gemma** — no test drives `npm run chat` through a
  real turn. Lens 1, 6.
- **Error-branch coverage** — the memory swallow, the `onSubmit` catch, the
  migration rollback. Lens 5.
- **Property-based testing** — none, and correctly so for this repo's invariants.
  Lens 5.
- **Tool-dispatch assertion in buffr** — the `search_knowledge_base` routing is
  deterministic and untested locally. Lens 6.
