# 10 — Self-critique and self-consistency

**Industry term:** self-critique / self-consistency (sampled voting) · *Language-agnostic* · **not yet exercised in buffr**

buffr answers once. There's no second pass that grades the answer, no N-sample vote. The whole loop is tuned toward *fewer* model calls (`maxToolCalls: 4`, `maxTurns: 6`), which is the opposite economic direction from these techniques. This file teaches both and the honest judgment of when the extra cost is worth it.

## Zoom out, then zoom in

You've added a code-review step that catches bugs before merge — a second look that's worth the time on risky changes and overkill on a typo fix. Self-critique is that second look for a model. buffr ships the first draft.

```
  Zoom out — where a second pass WOULD live

  ┌─ RagQueryAgent.answer ─────────────────────────────────┐
  │  current: search → synthesize → return (one pass)      │ ← buffr
  │  self-critique would add:                              │
  │     → critique the answer → revise → return            │ ← not present
  └────────────────────────────────────────────────────────┘
```

Zoom in: self-critique asks the model to evaluate its own output and revise; self-consistency runs the same prompt N times and votes. Both trade 2–5x tokens for reliability — and buffr's loop is built to minimize, not multiply, model calls.

## Structure pass

**Layers:** the single answer pass (buffr) vs an added critique/vote pass. **Axis — "how many model calls per answer, and why?":**

```
  axis: "model calls per answer"

  ┌─ buffr today ──────────┐ 1–N (search turns) → 1 synthesis  ← minimize
  ├─ self-critique ────────┤ + 1 critique + 1 revise           ← 2–3x
  └─ self-consistency ─────┘ × N samples + 1 vote               ← 2–5x
```

**Seam:** the post-synthesis boundary — the point right after the answer is produced, where a critique or a vote would slot in. buffr returns immediately there.

## How it works

### Move 1 — the mental model

Two kernels. Self-critique: answer → grade-your-own-answer → revise. Self-consistency: sample the same prompt N times → pick the majority answer.

```
  Self-critique             Self-consistency
  ┌─ answer ─┐              ┌─ sample 1 ─┐
  │  ▼       │              ├─ sample 2 ─┤ → vote → majority
  │ critique │              ├─ sample 3 ─┤
  │  ▼       │              └─ sample N ─┘
  │ revise   │
  └──────────┘
```

### Move 2 — buffr's stance and the tradeoff

**buffr is tuned the other way.** The loop's hard budgets (`maxToolCalls: 4`, `maxTurns: 6`) and the forced-synthesis nudge that forbids stalling ([06](06-single-purpose-chains.md)) all push toward *fewer* calls and a fast single answer. On a locally-served 9B model, each extra call is felt latency, so the default to "answer once" is a deliberate cost choice, not an oversight.

**When the extra cost would be worth it.** The spec's criteria, mapped to buffr: high-stakes outputs, low-trust classifiers, content hard to manually review. buffr's RAG answers over a *personal* KB are low-stakes and easy to eyeball — so neither technique pays here. The picture flips the moment buffr grows a feature that *edits the user's own data* (the buffr product vision involves composing vlogs from prose + clips; an LLM editing a user's journal entry is exactly the high-stakes case where a critique pass earns its keep).

**The diminishing-returns trap.** The honest limit on self-critique: a model critiquing its own output shares the blind spots that produced the output. If the model misread a retrieved chunk, asking it to critique its answer may just re-confirm the misread. Self-consistency dodges this partly (independent samples can disagree), but costs N× the tokens. Neither is free reliability.

### Move 3 — the principle

These techniques buy reliability at 2–5x the token budget — spend it where outputs are high-stakes or hard to review, not on cheap lookups. And remember the ceiling: a model grading itself inherits its own blind spots, so self-critique is a sharpener, not a second opinion. buffr's "answer once" is correct for its current low-stakes job and would be wrong the day it edits user data.

## Primary diagram

```
  cost vs reliability — buffr's position

  reliability ▲
              │           ● self-consistency (N×, votes)
              │      ● self-critique (2–3×)
              │ ● buffr (1×, answer once)  ← correct for low-stakes Q&A
              └─────────────────────────────► cost (tokens, latency)
```

## Project exercises

### EX-10-A — Add a self-critique pass gated on a stakes flag

- **Exercise ID:** EX-10-A
- **What to build:** An optional post-synthesis turn that asks the model to check its answer against the retrieved chunks (grounded? cited? hallucinated a number?) and revise — fired only when a `high_stakes` flag is set on the request.
- **Why it earns its place:** Gives buffr a reliability lever for the future data-editing features without taxing the common low-stakes Q&A path.
- **Files to touch:** conceptually the agent loop after `finalText`; an answer-level eval ([05](05-eval-driven-iteration.md)) to prove the critique reduces ungrounded answers.
- **Done when:** on the high-stakes eval slice, ungrounded-answer rate drops with the critique on; single-pass latency on the normal path is unchanged.
- **Estimated effort:** M.

## Interview defense

**Q: Why does this system answer once instead of critiquing or voting?**

Because its job is low-stakes and easy to review — personal-KB Q&A — and the loop is deliberately tuned to minimize model calls (hard tool-call and turn budgets, a nudge that forbids stalling). Self-critique and self-consistency cost 2–5x tokens for reliability, which pays on high-stakes or hard-to-review outputs, not on cheap lookups.

```
  answer once (low-stakes) ✓   |   critique/vote (high-stakes data edits)
```

Anchor: *"The limit I'd name is diminishing returns: a model critiquing itself shares the blind spots that made the answer. Self-consistency partly dodges that with independent samples, but at N× cost. I'd add a critique pass only behind a stakes flag — the day buffr edits a user's own content, that's when it earns the tokens."*

## See also

- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — how you'd prove a critique pass actually helps
- [06-single-purpose-chains.md](06-single-purpose-chains.md) — the minimize-calls loop these techniques push against
- [09-chain-of-thought.md](09-chain-of-thought.md) — the other token-for-reliability trade
