# Study — Testing & Correctness · buffr-laptop

> How do you *know* the code works — and will keep working after the next change?

That's the whole question this guide answers. A test suite is the thing that
tells you what a change broke before your users do. A suite that can't do that
is decoration. So the audit below isn't a coverage percentage — it's a **risk
map**: which paths in buffr fail loudly when broken, and which fail silently.

The verdict up front: **buffr's suite is small, honest, and well-isolated — and
it tests the wrong half of the risk.** Six test files, nine tests, nine passing.
Every test that touches Postgres is correct and deterministic. But the two files
that carry the actual conversation — `src/session.ts` (per-turn orchestration)
and `src/cli/chat.tsx` (the only interface) — have **zero tests**. The plumbing
is proven; the product isn't.

```
  The buffr correctness map — where tests sit vs where the risk sits

  ┌─ Interface layer ───────────────────────────────────────────┐
  │  src/cli/chat.tsx        Ink TUI, the only entry point       │
  │                          ★ ZERO TESTS — highest-leverage gap │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ session.ask(question)
  ┌─ Orchestration layer ─────────▼─────────────────────────────┐
  │  src/session.ts          persist → answer → flush → remember │
  │                          ★ ZERO TESTS — the ordering nobody  │
  │                            asserts                           │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ uses ↓
  ┌─ Persistence layer ───────────▼─────────────────────────────┐
  │  pg-vector-store.ts  ✓   trace-sink.ts  ✓   runtime.ts  ✓   │
  │  migrate.ts  ✓           profile.ts  ✓                       │
  │  config.ts  ✓ (pure, always runs)                            │
  │  ← every test here SKIPS when DATABASE_URL is unset          │
  └──────────────────────────────────────────────────────────────┘
```

## The seam that organizes everything: deterministic vs eval

There are two kinds of "is it right?" in an AI codebase, and they need
different tools. This guide owns one of them.

```
  ┌─ DETERMINISTIC correctness ──────┐   ┌─ PROBABILISTIC evaluation ──────┐
  │  given input X, assert output X  │   │  is the model output good       │
  │  "equals the expected value"     │   │  enough / did it regress?       │
  │                                  │   │  "scored above threshold"       │
  │  → THIS GUIDE (study-testing)    │   │  → study-ai-engineering         │
  │    config, pgvector ranking,     │   │    eval-cmd's precision@k,      │
  │    trace capture, migration      │   │    recall@k over a labeled set  │
  └──────────────────────────────────┘   └─────────────────────────────────┘
        the assertion is ==                    the assertion is "good enough"
```

The line is **determinism**. `assert.equal(hits[0].id, 'planted#0')` is a test
— a known input plants a known winner. `mean P@1 0.67` over a labeled query set
is an eval — it measures a non-deterministic retrieval+model output against a
"good enough" bar. buffr has both. `eval-cmd.ts` is the eval half and is
covered in `study-ai-engineering`, not here. When you test an AI feature you
build a **deterministic harness around a probabilistic core** — and buffr's
single sharpest example of that is the `fakeEmbedder` injection that lets a DB
test run without Ollama. That's where the two halves meet.

## Reading order

1. **`audit.md`** — Pass 1. The seven-lens audit. Start here. It walks
   coverage, test design, design pressure, determinism, edge cases, the
   AI-eval seam, and a consolidated red-flags checklist. Every finding is
   grounded in a real `file:line`.
2. The pattern files below — Pass 2. Each names one testing *technique* the
   suite exercises deliberately. Read the one whose name you don't already
   recognize.

```
  .aipe/study-testing/
    README.md   ← you are here
    audit.md    ← the 7-lens risk map (read first)
    01-env-gated-integration-tests.md   ← skip-by-default DB suite
    02-fake-embedder-injection.md       ← deterministic core swap (the seam)
    03-contract-parity-testing.md       ← PgVectorStore mirrors in-memory store
    04-idempotent-migration-test.md     ← run-it-twice schema proof
    05-full-signal-trajectory-test.md   ← all 6 events + replay ordering
```

## Cross-links to other guides

- **`study-software-design`** — "this code is hard to test" is a *design*
  finding, not a testing one. `session.ts`'s top-level `await
  createChatSession()` in `chat.tsx:62` and the all-in-one `ask()` are why the
  product layer has no tests. The audit's lens 3 points there; the fix lives
  there.
- **`study-ai-engineering`** — owns the eval half: `eval-cmd.ts`'s
  precision@k / recall@k, the labeled `eval/queries.json` set, and what a
  regression gate on the model output should look like.
- **`study-debugging-observability`** — the trace sink (`05-full-signal-
  trajectory-test.md`) is the same artifact that powers replay-based
  debugging. The test proves the trajectory is complete; that guide uses the
  trajectory to debug a bad turn.
