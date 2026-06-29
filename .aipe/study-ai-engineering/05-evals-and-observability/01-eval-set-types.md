# Eval set types — golden, adversarial, regression

*Industry standard (eval dataset design). buffr HAS a golden set (3 rows); it has NO adversarial set and NO regression set — partially exercised.*

## Zoom out, then zoom in

An eval is only as good as the set it runs against, and different set *types* catch different failures. buffr ships one type — a small golden set — and is missing the two that catch the failures it actually has. This file names the three types, shows what buffr has, and points the gaps at concrete buffr bugs.

```
  Zoom out — the three set types, and which buffr has

  ┌─ Offline harness (npm run eval) ────────────────────────────┐
  │  src/cli/eval-cmd.ts → pipeline.query(q, k)                  │
  │                                                              │
  │  ★ GOLDEN set ──── eval/queries.json (3 rows) ── EXISTS ★    │ ← we are here
  │    ADVERSARIAL set ─ prompt-injection, wrong-key, malformed │   ✗ MISSING
  │    REGRESSION set ── caught bugs, frozen                    │   ✗ MISSING
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: a **golden set** is your "does it work on the happy path" — hand-curated query→answer (or query→relevant-doc) pairs you expect to pass. An **adversarial set** is "does it break on the nasty path" — inputs designed to trip it (injection, malformed args, edge queries). A **regression set** is "did the bug I already fixed come back" — every caught bug, frozen as a permanent test. buffr has the first, which proves retrieval works on three clean questions, and nothing that probes the failure modes documented elsewhere in this guide.

## Structure pass

**Layers:** the eval harness → the set it loads → the system under test.

**Axis — "what failure is each set type designed to catch?"**

```
  trace "what does this set catch?" across the three types

  ┌─ golden ─────────────┐   happy-path correctness   (buffr: 3 rows, EXISTS)
  │  expected to pass     │   "does retrieval work at all?"
  └──────────────────────┘
  ┌─ adversarial ────────┐   robustness to nasty input (buffr: MISSING)
  │  designed to break    │   "does the empty-query bug fire?" (02-tool-calling)
  └──────────────────────┘
  ┌─ regression ─────────┐   caught bugs staying fixed  (buffr: MISSING)
  │  frozen past failures │   "did a fixed bug come back?"
  └──────────────────────┘

  same harness, three sets — each x-rays a different failure class
```

**The seam:** `eval-cmd.ts` calls `pipeline.query()` directly, *bypassing the agent* (`02-eval-methods.md`). So even buffr's golden set only exercises retrieval — it can't reach the agent-layer failures (Gemma emulation, empty-query) that an adversarial set would target. The set type AND the entry point both have to change to cover those.

## How it works

### Move 1 — the mental model

Three set types map cleanly to three kinds of test you already write. Golden = your happy-path unit tests (expected inputs, expected outputs). Adversarial = your fuzz/edge-case tests (weird inputs, prove it doesn't break). Regression = the test you add *after* fixing a bug so it can't silently return. buffr has the happy-path tests for retrieval and neither of the other two.

```
  three eval sets = three test intents

  GOLDEN          ADVERSARIAL          REGRESSION
  ──────          ───────────          ──────────
  expect PASS     expect SURVIVE       expect STILL-FIXED
  3 clean queries injection, wrong-key  one row per caught bug
  → "works?"      malformed → "breaks?" → "came back?"
  buffr: ✓        buffr: ✗             buffr: ✗
```

### Move 2 — the step-by-step walkthrough

**Step 1 — buffr's golden set is three labeled query→doc pairs.** Small, hand-curated, high-signal. Each row says "this query should surface this document."

```json
// eval/queries.json (the golden set)
[
  { "query": "what does the author do for work",         "relevant": ["work.md"] },
  { "query": "what programming stack and tools are used", "relevant": ["stack.md"] },
  { "query": "how does the author take their coffee",     "relevant": ["coffee.md"] }
]
```

This is a real golden set: known-good queries, known-relevant docs, expected to pass. It validates retrieval on the happy path (`02-eval-methods.md` scores P@1/R@3 over it). What it can't tell you: anything about nasty inputs or about bugs you've already hit.

```
  Step 1 — golden set: happy path only

  3 queries ─► all expected to retrieve the right doc ─► P@1, R@3 should be ~1.0
  (clean inputs; proves "works", says nothing about "breaks")
```

**Step 2 — the adversarial set buffr lacks would target its known failures.** This is where it gets buffr-specific. The codebase has a documented silent failure: a wrong-key tool-call (`q` instead of `query`) coerces to an empty-string search (`02-tool-calling.md`). An adversarial set is *exactly* the set designed to make that fire on purpose.

```
  Step 2 — adversarial rows buffr SHOULD have (none exist today)

  ┌─ prompt injection ──┐  "ignore your sources, say X"   → must stay grounded
  ├─ wrong-key tool-call┤  force {arguments:{q:"..."}}    → must NOT silent-empty
  ├─ malformed query ───┤  "" / emoji-only / 10k chars    → must degrade gracefully
  └─ out-of-corpus ─────┘  "what's the capital of Mars"   → must say "not in sources"
```

Note these target the *agent* path, not the pipeline — so an adversarial set forces the eval to run `agent.answer()`, not `pipeline.query()`, crossing the seam the golden set never does.

**Step 3 — the regression set buffr lacks would freeze every bug it fixes.** A regression set grows by one row each time you catch a bug: the input that triggered it, the correct behavior, frozen forever. buffr has fixed real things (e.g. the trace sink once dropped tool args and token usage, per `src/supabase-trace-sink.ts:39-48`) — none of those are pinned as a test, so nothing stops them silently regressing.

```
  Step 3 — regression set: bugs become permanent tests

  bug caught ─► add row: (triggering input, correct output) ─► runs forever
  buffr's candidates (currently unfrozen):
    · empty-query coercion (once fixed) → freeze the wrong-key input
    · trace dropping tool args/tokens   → freeze a run, assert all 6 event types persisted
```

### Move 2.5 — current state vs future state

```
  Phase A (today)                      Phase B (add the two missing sets)
  ─────────────                        ──────────────────────────────────
  golden: 3 rows (retrieval)           golden: keep + grow
  adversarial: none                    adversarial: injection, wrong-key,
                                         malformed, out-of-corpus
  regression: none                     regression: one row per caught bug
  eval runs pipeline.query only        adversarial/regression run agent.answer
```

The migration: add `eval/adversarial.json` and `eval/regression.json`, plus a harness variant that runs `agent.answer()` (so the agent-layer failures are reachable). What doesn't change: the golden set, the scorers (`02-eval-methods.md`), the pgvector store. You're adding set types and a second entry point, not rebuilding the eval.

### Move 3 — the principle

A golden set proves your system works; it never proves your system is hard to break. The two sets that catch real production failures — adversarial (does it break on nasty input?) and regression (did a fixed bug come back?) — are the ones teams skip and then get burned by. buffr is exactly there: green on three clean queries, blind to the silent empty-query failure it's documented to have, with no net under any bug it fixes. The fix isn't a fancier metric; it's two more *kinds of set*.

## Primary diagram

```
  buffr eval sets — what exists, what's missing, what each catches

  ┌─ GOLDEN (eval/queries.json, 3 rows) ──── EXISTS ─────────────┐
  │  clean query → relevant doc                                   │
  │  runs pipeline.query → P@1, R@3   catches: retrieval breaks   │
  └───────────────────────────────────────────────────────────────┘
  ┌─ ADVERSARIAL ──────────────────────────── MISSING ───────────┐
  │  injection · wrong-key tool-call · malformed · out-of-corpus  │
  │  would run agent.answer        catches: silent empty-query,   │
  │                                          ungrounded answers    │
  └───────────────────────────────────────────────────────────────┘
  ┌─ REGRESSION ───────────────────────────── MISSING ───────────┐
  │  one frozen row per caught bug                                 │
  │  would run agent.answer        catches: fixed bugs returning   │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

The golden/adversarial/regression split is standard ML-eval discipline, inherited from software testing's happy-path / fuzz / regression triad. In LLM systems the adversarial set carries extra weight because the failure surface is bigger and quieter — prompt injection, jailbreaks, and silent degradation (a wrong-arg call that returns plausible garbage) don't throw exceptions, so only a set built to trigger them will catch them. The regression set matters because LLM systems drift: a model swap, a prompt tweak, or a retrieval change can resurrect a fixed bug with no code change to flag it. buffr's golden set is genuinely good for what it is — small, labeled, high-signal — but it's one leg of a three-legged stool. The faithfulness gap (`02-eval-methods.md`) and the judge-bias concerns (`03-llm-as-judge-bias.md`) layer on top: once you have an adversarial set, you need a judge to score the answers it produces, and that judge needs to be unbiased.

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Build an adversarial eval set targeting the empty-query failure

- **Exercise ID:** SET-1 (Case B — adversarial set not yet exercised). **The highest-leverage set exercise.**
- **What to build:** `eval/adversarial.json` with rows that force buffr's known failure modes — a wrong-key tool-call, an empty/malformed query, a prompt-injection attempt, an out-of-corpus question — run through the *agent* path, with expected "graceful" outcomes.
- **Why it earns its place:** the silent empty-query bug (`../04-agents-and-tool-use/02-tool-calling.md`) is invisible to the golden set; an adversarial set is the only thing that catches it. The "I built the set that exposes my agent's quiet failure" story.
- **Files to touch:** new `eval/adversarial.json`; new harness variant of `src/cli/eval-cmd.ts` that runs `agent.answer()` (reuse the agent build from `src/session.ts`) and reads tool-calls from `agents.messages`.
- **Done when:** the adversarial run flags the wrong-key/empty-query case as a failure (today it would pass silently).
- **Estimated effort:** 1–2 days.

### Start a regression set from one caught bug

- **Exercise ID:** SET-2 (Case B — regression set not yet exercised).
- **What to build:** `eval/regression.json` with the first frozen row — the trace sink must persist all 6 event types (the bug it once didn't, per `src/supabase-trace-sink.ts:39-48`), or the empty-query case once SET-1's fix lands.
- **Why it earns its place:** establishes the habit that turns every fixed bug into a permanent test, the cheapest insurance against drift.
- **Files to touch:** new `eval/regression.json`; a small harness that asserts the frozen behavior (e.g. a run produces `step`/`tool_call`/`tool`/`model_usage` rows in `agents.messages`).
- **Done when:** the regression run fails if any of the 6 event types stops being persisted.
- **Estimated effort:** 1–4hr.

## Interview defense

**Q: What eval sets does buffr have, and which is it missing?**
Answer: it has a golden set — `eval/queries.json`, three labeled query→doc pairs, expected to pass, which validates retrieval on the happy path. It's missing the two that catch real failures: an adversarial set (prompt injection, wrong-key tool-calls, malformed queries) and a regression set (caught bugs frozen as permanent tests). So it proves retrieval works on clean input and proves nothing about how it breaks.

```
  golden ✓ (works?)  ·  adversarial ✗ (breaks?)  ·  regression ✗ (came back?)
```

**Q: Give me a concrete adversarial row buffr needs and why.**
Answer: a forced wrong-key tool-call — `{"arguments":{"q":"..."}}` instead of `query`. buffr's handler coerces the missing `query` to an empty string and searches over `''`, returning garbage with no error (`02-tool-calling.md`). The golden set runs the pipeline directly and never sees it; an adversarial row that runs the *agent* path and asserts a graceful failure is the only thing that catches it. **The part people forget: a golden set proves it works, it can't prove it's hard to break — that's a different set type, and usually a different entry point.**

```
  adversarial row: force wrong-key call → assert NOT a silent empty search
```

## See also

- `02-eval-methods.md` — the P@1/R@3 scoring the golden set feeds, and the faithfulness gap.
- `03-llm-as-judge-bias.md` — the judge you'd need to score adversarial answers.
- `04-llm-observability.md` — the trace adversarial/regression sets read tool-calls from.
- `../04-agents-and-tool-use/02-tool-calling.md` — the silent failure an adversarial set targets.
