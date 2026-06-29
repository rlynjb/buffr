# 05 — Evals and Observability (LLM side)

**Anchor:** LLM application engineering. buffr measures retrieval offline and traces every run; it does not yet measure answer faithfulness.

```
  what buffr measures vs what it doesn't

  ┌─ MEASURED (wired) ──────────────────────────────────────────┐
  │  precision@k / recall@k over eval/queries.json              │
  │   → src/cli/eval-cmd.ts (npm run eval)                       │
  │  full-signal trajectory trace → agents.messages             │
  │   → src/supabase-trace-sink.ts (all 6 CapabilityEvent types) │
  │  per-call token usage → messages.tokens_used                │
  └─────────────────────────────────────────────────────────────┘
  ┌─ NOT MEASURED (the gap) ────────────────────────────────────┐
  │  FAITHFULNESS — did the answer use the retrieved chunks?     │
  │   RubricJudge exists in aptkit, wired into NOTHING here.     │
  │   A hallucinated answer over perfect chunks scores 1.0.      │
  └─────────────────────────────────────────────────────────────┘
```

## Reading order

1. `02-eval-methods.md` — precision@k/recall@k (wired) and the faithfulness gap (unwired RubricJudge). **The core file.**
2. `04-llm-observability.md` — the full trajectory trace, the 6 event types, token persistence. **buffr-specific.**
3. `01-eval-set-types.md` — golden (the 3-row set), adversarial, regression — mostly study + Case B.
4. `03-llm-as-judge-bias.md` — position/verbosity/self-preference bias, relevant the moment RubricJudge is wired.

## Exercised vs not

**Exercised:** offline retrieval eval (P@1, R@3), full-signal trajectory observability, token usage capture.

**Not yet exercised:** faithfulness / LLM-as-judge eval (RubricJudge unwired), adversarial + regression eval sets, judge-bias mitigation (no judge running), replay (traces are captured but no replay harness in buffr). Each file is honest about the gap.

## See also

- `.aipe/study-testing/` — the eval seam, `node:test`, DB-gated tests, RubricJudge as the missing faithfulness test.
- `../04-agents-and-tool-use/02-tool-calling.md` — the silent failure the current evals don't catch.
