# Overview — the testing audit at a glance

`buffr-laptop` has **9 tests across 6 files, all passing** (`npm test` = `tsc` build then `node --test --test-concurrency=1 dist/test/*.test.js`). For a single-device personal project this is a real suite, not decoration — but most of it is *green by skip*: 7 of the 9 tests gate on `DATABASE_URL` and silently skip when it's unset, so a clean checkout with no database reports success while exercising almost nothing.

The verdict: **the test design is sound where it exists** — real integration against Postgres, a deterministic fake embedder, a contract test on the persistence port. The problem isn't quality, it's *coverage*. The orchestration layer that ties the whole agent together is untested.

---

## Coverage map — the RISK map, not the percentage

```
  buffr-laptop — what has tests, what doesn't

  ┌─ Pure / unit ───────────────────────────────────────────────┐
  │  src/config.ts          ✓ 2 tests, ALWAYS run (no DB gate)   │
  └──────────────────────────────────────────────────────────────┘
  ┌─ Integration (DATABASE_URL-gated, SKIP when unset) ──────────┐
  │  src/migrate.ts         ✓ idempotent run-twice                │
  │  src/pg-vector-store.ts ✓ upsert+rank, dimension-mismatch     │
  │  src/profile.ts         ✓ stored-or-empty                     │
  │  src/runtime.ts         ✓ documents row + chunks              │
  │  src/supabase-trace-sink.ts ✓ all 6 events + ordering         │
  └──────────────────────────────────────────────────────────────┘
  ┌─ UNTESTED — the orchestration + UI layer ───────────────────┐
  │  ★ src/session.ts       ✗ createChatSession + per-turn ask() │ ← highest leverage
  │    src/cli/chat.tsx      ✗ Ink UI (busy-guard, /exit, error)  │
  │    src/db.ts             ✗ trivial Pool factory (low value)   │
  │    src/cli/index-cmd.ts  ✗ thin CLI wrapper                   │
  │    src/cli/eval-cmd.ts   ✗ EVAL script, not a unit test       │ → study-ai-engineering
  └──────────────────────────────────────────────────────────────┘

  data flow: chat.tsx → session.ts → {pg-vector-store, profile,
             trace-sink, aptkit agent}.  The LEAVES are tested;
             the TRUNK that wires them is not.
```

The shape to notice: testing went **bottom-up**. Every leaf module that does one job — store a vector, load a profile, persist an event — has a focused test. The trunk that composes them into a working chat turn (`session.ts`) has none. That's backwards from where the regressions will come from: a leaf has one responsibility and rarely breaks subtly; the orchestrator has ordering, error-swallowing, and lifecycle, which is exactly where subtle breakage hides.

---

## The three highest-leverage gaps

Ranked by how many real regressions a test would catch.

### 1. `src/session.ts` — `ask()` ordering and the swallowed memory-write (worst)

`createChatSession().ask()` does four things in a fixed order: persist the user turn → run the agent → flush the trace → best-effort `memory.remember()` inside a `try/catch` that **swallows** the error (`src/session.ts:60-71`). Three invariants live here and none is tested:

- **persist-then-answer ordering** — the user message must be written *before* the agent runs, so a crash mid-turn still leaves a record of what was asked.
- **trace.flush() happens before return** — the sync `emit()` queues writes; if `flush()` is skipped, the trajectory is lost.
- **the swallowed memory-write** — a memory failure must not lose the answer the user already has. The `catch {}` is deliberate (it's even commented), which makes it *exactly* the kind of branch that silently rots: nothing tells you when it starts eating real errors.

This is deterministic and testable today — inject a fake agent and a fake pool, assert call order and that a throwing `memory.remember` still returns the answer. It's the single test that would catch the most production breakage.

### 2. `src/cli/chat.tsx` — the busy-guard and the error turn

The Ink component has real logic that isn't UI fluff: the `if (busy) return` re-entrancy guard (`chat.tsx:17`), the `/exit` / `/quit` close path (`chat.tsx:18-22`), and the `catch` that renders `error: <message>` as a buffr turn (`chat.tsx:30-32`). A double-submit while a turn is in flight, or an `ask()` rejection, both have defined behavior that no test pins. `ink-testing-library` makes this reachable. Note the design friction — the file does `await createChatSession()` at module top level (`chat.tsx:62`), so importing it for test fires a real session; that's a **design** smell, cross-linked to `study-software-design`, not a testing finding.

### 3. The whole DB suite is green-by-skip in CI

7 of 9 tests skip without `DATABASE_URL`. There is no CI config in the repo that provisions a Postgres, so on any machine without a local DB the suite passes while testing only `loadConfig`. The gate itself is the *right* pattern (see `01-env-gated-integration-tests.md`) — the gap is that nothing guarantees the gated half ever actually runs. The fix isn't to remove the gate; it's a CI job with a pgvector service container so the integration half runs on every push.

---

## One-line verdict per lens

| # | Lens | Verdict |
|---|------|---------|
| 1 | what-is-tested-and-what-isnt | Leaves tested, trunk (`session.ts`) not — backwards from the risk. |
| 2 | test-design-and-levels | Healthy: real integration, no over-mocking, one always-run unit test. |
| 3 | tests-as-design-pressure | `chat.tsx` top-level `await` is the one untestable seam → software-design. |
| 4 | determinism-isolation-and-flakiness | Strong: `--test-concurrency=1`, fake embedder, `beforeEach` cleanup by `app_id`. |
| 5 | edge-cases-and-error-paths | Thin: dimension-mismatch is the only error branch tested; the swallowed `catch` isn't. |
| 6 | testing-ai-features | The seam is handled right — deterministic harness over a synthetic event stream. |
| 7 | testing-red-flags-audit | 2 of 8 red flags firing (green-by-skip CI; untested orchestration trunk). |

Full walk with `file:line` grounding in **`audit.md`**.
