# 05 · Evals and Observability

> How buffr knows whether retrieval is any good — and how it records what the agent actually did, run by run.

Everything upstream of this folder *produces* behavior: the embedding picks chunks, the agent calls tools, the model writes an answer. This folder is where that behavior gets **measured** and **recorded**. The eval harness is the connective tissue — it's the one place that runs the whole pipeline against a fixed input set and turns "feels better" into a number. The trace sink is the other half: it captures, per request, the exact trajectory the agent took so you can read it back later.

You already own the testing primitives — assertions, fixtures, CI gates. An eval *is* a test whose oracle is fuzzy: the assertion isn't `===`, it's a score against a labeled set. This sub-section teaches the eval-specific parts on top of what you know, and is brutally honest about the two things buffr records but does **not** yet judge.

```
05-evals-and-observability/
│
│  WHAT TO MEASURE ──► HOW TO MEASURE ──► JUDGE BIAS ──► WHAT TO RECORD
│
├── 01-eval-set-types.md      ★ golden set (eval/queries.json, 3 items)
│                               ◇ no adversarial set, no regression set (Case B)
│
├── 02-eval-methods.md        ★ EXACT-MATCH on docIds: precision@k / recall@k
│                               ◇ no rubric / no judge method wired (Case B → 03)
│
├── 03-llm-as-judge-bias.md   ◇ THE UNWIRED RubricJudge — exists in aptkit,
│                               buffr never calls it → FAITHFULNESS unmeasured (Case B)
│
└── 04-llm-observability.md   ★ SupabaseTraceSink: all 6 events → agents.messages
                                ◇ replay-runner exists, unwired; no dashboard (Case B)

  ★ = implemented in buffr (Case A)   ◇ = named gap, primary build target (Case B)
```

## Reading order

Read in number order. They go: what you measure against, how you measure it, why the fancier "how" lies to you, and how you record what happened.

1. **`01-eval-set-types.md`** — the three kinds of eval set (golden, adversarial, regression). buffr has exactly one: the **golden set** (`eval/queries.json`, 3 hand-labeled queries). Small, high-signal, honest — and the only one. The adversarial and regression sets are named gaps you build.
2. **`02-eval-methods.md`** — the method ladder from exact-match up through human eval. buffr sits on the bottom rung and stays there *on purpose*: **exact-match on docIds** via `scorePrecisionAtK` / `scoreRecallAtK`, driven by `src/cli/eval-cmd.ts`. This rung measures **retrieval**, not the answer.
3. **`03-llm-as-judge-bias.md`** — the rung buffr skipped, and why it's load-bearing. The **LLM-as-judge** (the unwired `RubricJudge`) exists in aptkit and is never constructed in buffr, so buffr **does not measure faithfulness** — whether the answer stays grounded in the retrieved chunks. This is the headline gap. Read it with the judge's known biases (position, verbosity, self-preference) in hand, because the fix is the exercise.
4. **`04-llm-observability.md`** — what buffr *does* record well. The **trace sink** (`SupabaseTraceSink`) persists all six event types into `agents.messages`: traces (per request) and spans (tool calls, `durationMs`, tokens). The replay runner exists in aptkit but is unwired; there's no dashboard, no dollar cost.

## Phase 3 anchor

The driving exercises for this sub-section are **Phase 3 — measure and observe** ([B3.x], cite [C3.1]–[C3.12]). The work splits cleanly along the ★/◇ line:

> **Strengthen what's measured** ([B3.1]–[B3.5]) — grow the golden set past 3 items, add a per-query failure view, and add a tokens/latency summary query over the traces buffr already captures.

> **Close the named gaps** ([B3.6]–[B3.12]) — add an **adversarial set** (prompt-injection queries that must refuse), freeze production failures into a **regression set**, **wire the `RubricJudge`** into a faithfulness eval over `eval/queries.json`, and wire the **replay runner** so a recorded trajectory can be re-run and re-asserted.

**The honest state, stated plainly:** buffr *measures retrieval* (precision@k / recall@k over a 3-item golden set) and *records trajectories* (all six events, with durations and tokens, in a local table). buffr does **not** measure generation faithfulness — the `RubricJudge` is built in aptkit and never wired — and it does **not** replay or visualize what it records. Those aren't apologies; they're the clean seams Phase 3 fills.

## Cross-links

- **`../03-retrieval-and-rag/`** — what the golden set measures. `11-rag.md` is the pipeline `eval-cmd.ts` runs; `02-embedding-model-choice.md` is why a docId-level golden set is the right granularity. The faithfulness gap named here is the same one flagged in `03`'s [B2A.8].
- **`../06-production-serving/`** — the trace sink's tokens/latency data is the raw material for cost tracking and rate limiting; observability is the precondition for serving anything you can't see.
- **`study-testing/`** — the eval seam in detail: `node:test`, fixtures, the `DATABASE_URL`-gated suite. An eval is a test with a fuzzy oracle; that sub-section covers the harness, this one covers the oracle.
