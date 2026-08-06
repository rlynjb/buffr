# 09 — Predict-Then-Reveal Calibration Loop

**Subtitle:** Industry names: closest is **calibration training** / **forecast-then-score** (the
Good Judgment Project / Tetlock's "superforecasting" tournaments track a forecaster's predictions
against real outcomes the same way). No single settled framework name covers the *agent*-side half
of this shape, so the repo's own name stands: the **predict-then-reveal calibration loop**. Type
label: Project-specific (assembled from `research-flow.ts`, `review-flow.ts`, and the
`JournalStore` contract; not a name you'd find in a library). IMPLEMENTED in buffr.

## Zoom out, then zoom in

```
  Zoom out — a loop that spans two separate command invocations, not one

  ┌─ UI layer (src/cli/chat.tsx) ─────────────────────────────────────────┐
  │  /research <topic>  (session A, t=0)     /review  (session B, t=later)│
  └──────────┬──────────────────────────────────────────┬────────────────┘
             │                                          │
  ┌─ Flow layer ────────▼──────────────────┐  ┌─────────▼──────────────────┐
  │  research-flow.ts: predict→reveal→      │  │  review-flow.ts: keep/     │
  │  promote                                │  │  snooze/resolve(disposition)│
  └──────────┬──────────────────────────────┘  └─────────┬──────────────────┘
             │  session.saveDecision()                    │  session.listDueReviews()/
             ▼                                            │  resolveReview()
  ┌─ Journal layer (packages/kernel/src/journal/, src/pg-journal-store.ts) ─┐
  │              ★ THE LOOP CLOSES HERE — agents.decisions row ★           │ ← we are here
  └───────────────────────────────────────────────────────────────────────┘
```

Everything you've read so far in this guide — the ReAct loop, the capability pipelines, the
checkpoint in `08` — produces an answer once per call and returns it. This pattern is different in
kind: it's a loop that closes **across time**, not across turns of one conversation. A human
predicts something *now*. buffr reveals its own read *now*. The pair gets promoted to a tracked
decision. Then, days or weeks later, in a completely separate `/review` invocation, the human tells
buffr what actually happened. Name the shape: **agent-as-calibration-partner**, not
**agent-as-oracle**. An oracle gives you its best answer once. A calibration partner structures the
interaction so *your own* judgment gets scored against reality, with the agent as the referee that
enforces the ordering.

## Structure pass

**Files this pattern spans:**

- `src/cli/research-flow.ts` — predict → reveal → promote (the first three steps, all within one
  `/research` session)
- `src/cli/review-flow.ts` — keep / snooze / resolve (the fourth step, a *different* session)
- `packages/kernel/src/journal/contracts.ts` — `JournalStore`, `JournalEntry`, `JournalStatus`
  (:3), `Disposition` (:4) — the contract that survives the gap between sessions
- `src/pg-journal-store.ts` — `PgJournalStore`, the Postgres adapter (durable across restarts,
  unlike `08`'s in-memory pause)
- `sql/002_decision_journal.sql` / `agents.decisions` — the table the loop's memory lives in

Axis: **lifecycle — when does each step actually happen, relative to the human sitting at the
terminal.**

```
  Axis = lifecycle · trace it across the four steps, find where it flips

  predict   → request-time, within /research invocation #1
  reveal    → request-time, same invocation, immediately after predict
  promote   → request-time, same invocation — writes agents.decisions, status='open'
  ─────────────── ★ SEAM: the axis flips — time actually passes ★ ───────────────
  resolve   → request-time of a DIFFERENT invocation (/review), whenever the human
              runs it next — hours, days, or weeks later
```

**The seam is the row itself.** The `agents.decisions` row (a `JournalEntry`) is the entire memory
that survives from session A to session B. What crosses the seam: `prediction`, `assessment`,
`stake`, `resolutionCondition`, `reviewAt`, `evidenceIds`. What does **not** cross: the model's
conversation state, the TUI's `activeFlow` closure, the full evidence text, anything from
`08`'s pause. That narrowness is deliberate — the contract between the two sessions is a handful of
typed fields in a database row, not a resumable process.

## How it works

### Move 1 — the mental model

You've already built this shape, in a different domain: dryrun's spaced-repetition scheduler
persists a card's next-review date and resurfaces it later, independent of the session that created
the card. This is the same idea applied to a judgment instead of a flashcard — predict now, get
scored today, come back on a review date to see whether reality agreed with either of you.

```
  THE SHAPE — three steps now, one step later, a row bridging the gap

  Session A (t=0, one /research invocation)
  ┌────────────┐   ┌────────────┐   ┌────────────┐
  │  PREDICT   │──►│  REVEAL    │──►│  PROMOTE   │
  │ human types│   │ buffr shows│   │ stake +    │
  │ score/dim/ │   │ gap + one  │   │ resolution │
  │ confidence │   │ principle  │   │ + reviewAt │
  └────────────┘   └────────────┘   └─────┬──────┘
                                            │ agents.decisions row, status='open'
                                            │      ... days or weeks pass ...
                                            ▼
  Session B (t=later, a DIFFERENT /review invocation)
  ┌─────────────────────────────────────────────────┐
  │  RESOLVE — keep / snooze / resolve(disposition)  │
  │  human states what actually happened, in words   │
  └─────────────────────────────────────────────────┘
```

### Move 2 — the load-bearing skeleton

**Isolate the kernel.** Four steps, one durable record. Drop any step and it stops being a
calibration loop:

- **predict, captured before reveal** (`research-flow.ts` `PREDICTION_PROMPT` :37-42,
  `parsePrediction` :44-54) — the human types `<score> <dimension> <confidence>` before buffr shows
  anything beyond the safe digest from `08`. Without this, "reveal" has nothing to compare against
  and the loop degenerates into a plain oracle answer.

- **reveal, computed in code, not asked of the model** — the comparison is `08`'s
  `PredictionComparison` (`engine.ts:202-208`), reused here as the reveal payload:
  `formatReveal()` (`research-flow.ts:56-69`) prints the gap (`scoreGap`), the dimension match, and
  — new since `01a212e` — the Teacher's `principle` and `reflectionQuestion`
  (`teacher/index.ts:20-22`). This is the moment coordinator-worthy of calling out on its own: the
  Teacher capability doesn't just hand back a score anymore. Its `submit_explanation` tool schema
  now requires `principle` ("one transferable, general principle this result illustrates —
  something the user could apply to a different subject") and `reflectionQuestion` ("one question
  that would help the user decide whether this is worth validating further")
  (`teacher/index.ts:29,34-35`), each with a fallback if the model's tool call omits them
  (`fallbackPrinciple`, `:40-44`; `FALLBACK_REFLECTION_QUESTION`, `:46`). Without this, "reveal"
  would be a scoreboard; with it, the reveal step is where the system *teaches*, not just judges.

- **promote, with a durable status lifecycle** (`JournalStatus` = `'open' | 'review-due' |
  'resolved' | 'discarded'`, `contracts.ts:3`) — `saveDecision()` (`session.ts:758-783`) writes one
  row with `status='open'`, `reviewAt`, `stake`, `resolutionCondition`. Without a persisted status
  machine, there'd be no way to know later whether a given decision is still open, snoozed, or
  already judged — every `/review` would have to ask the human to re-describe every open bet from
  memory.

- **resolve, with a disposition captured directly from the human** (`Disposition = 'successful' |
  'unsuccessful' | 'inconclusive'`, `review-flow.ts` `parseDisposition` :27-30) — the human states
  what happened, in their own words, via a free-text `note`. Without this, the loop only ever
  produces predictions, never verdicts, and "is my judgment well-calibrated" has no ground truth to
  check against. Note what buffr deliberately does *not* do here: it never asks a model "was this
  decision successful?" — that would just be another guess. The human is the only source of
  resolution truth.

**Optional hardening, not skeleton:** `listDue()`'s side effect of flipping `open` → `review-due`
as it queries (`contracts.ts:61-65` documents this; `pg-journal-store.ts:86-92` implements it as an
`UPDATE ... where status='open' and review_at <= $now` immediately followed by a `SELECT`) is what
makes `/review`'s queue deterministic without a separate cron job — a real design choice, but not
what makes this pattern *this* pattern. Same for `snooze()`, which just pushes `reviewAt` forward.

### The code, side by side

```ts
// src/cli/research-flow.ts:56-69 — reveal: comparison + principle + reflection, all in one message.
function formatReveal(output: MarketResearchOutput): string {
  const c = output.comparison;
  const matchLine = c.dimensionMatched
    ? `Dimension match: yes — both picked ${c.actualDimension}.`
    : `Dimension match: no — you picked ${c.prediction.expectedDimension}, strongest was ${c.actualDimension}.`;
  return [
    `Your call: ${c.prediction.expectedScore}   buffr: ${Math.round(output.summary.totalScore)}   gap: ...`,
    matchLine, '',
    `Principle: ${output.summary.principle}`,        // ← teaching, not just scoring
    `Reflect: ${output.summary.reflectionQuestion}`,  // ← an open question back to the human
  ].join('\n');
}
```

```ts
// src/cli/research-flow.ts:143-158 — promote: the row that survives to /review.
const reviewAt = parseDayCountOrDate(input);
await session.saveDecision({
  topic, evidenceIds: collected.evidence.map(e => e.sourceId),
  stake, resolutionCondition, reviewAt,
  prediction: prediction!,                            // what the human guessed
  assessment: { score: output!.summary.totalScore, confidence: output!.summary.confidence },
});                                                      // what buffr scored
step = 'done';
```

```ts
// packages/kernel/src/journal/contracts.ts:61-72 — the contract that spans the two sessions.
export type JournalStore = {
  create(entry: NewJournalEntry, now: string): Promise<JournalEntry>;
  listDue(userId: string, workspaceId: string, now: string): Promise<JournalEntry[]>;
  // ^ side effect: any 'open' entry with reviewAt <= now flips to 'review-due' as it's listed
  snooze(id: string, reviewAt: string): Promise<JournalEntry>;
  resolve(id: string, disposition: Disposition, note: string, now: string): Promise<JournalEntry>;
};
```

```ts
// src/pg-journal-store.ts:86-100 — listDue(): UPDATE then SELECT, both scoped by app_id.
async listDue(userId, workspaceId, now): Promise<JournalEntry[]> {
  await this.pool.query(
    `update agents.decisions set status = 'review-due'
     where app_id = $1 and user_id = $2 and workspace_id = $3
       and kind = 'decision' and status = 'open' and review_at <= $4`,
    [this.appId, userId, workspaceId, now],
  );
  const { rows } = await this.pool.query(
    `select * from agents.decisions where app_id = $1 and user_id = $2
     and workspace_id = $3 and status = 'review-due' order by review_at asc`,
    [this.appId, userId, workspaceId],
  );
  return rows.map(rowToEntry);
}
```

```ts
// src/cli/review-flow.ts:95-108 — resolve: the human states the ground truth.
if (step === 'disposition') {
  const disposition = parseDisposition(input);         // 'successful'|'unsuccessful'|'inconclusive'
  pendingDisposition = disposition;
  step = 'note';
  return { messages: ['Any note? (or leave blank)'], step };
}
// step === 'note'
await session.resolveReview(currentEntry().id, pendingDisposition!, input.trim());
```

```
  Layers-and-hops — the seam between session A and session B

  ┌─ Session A (t=0) ─────┐  hop 1: saveDecision()   ┌─ agents.decisions ────┐
  │  research-flow.ts     │ ───────────────────────► │  status='open'         │
  │  predict→reveal→promote│                          │  prediction+assessment │
  └────────────────────────┘                          └───────────┬────────-─┘
                                                          hop 2: reviewAt <= now
                                                                    │ (whenever /review runs)
  ┌─ Session B (t=later) ─┐  hop 4: resolveReview()   ┌─────────────▼──────────┐
  │  review-flow.ts        │ ◄─────────────────────── │  listDue(): open→due   │
  │  keep/snooze/resolve   │  hop 3: due entries shown │  (status flip as a side │
  └────────────────────────┘                          │   effect of listing)    │
                                                        └─────────────────────-──┘
```

### Move 2.5 — current state vs future state

`JournalStore` persists every prediction and every assessment, but nothing today reads *past*
decisions back into a *future* `/research` call. buffr doesn't yet compute "you're usually 15 points
optimistic on `monetizability`" and feed that back into how a new prediction is framed, or into the
Analyzer's own confidence. The infrastructure for that exists — `listDue()` already queries by
`userId`/`workspaceId`, and every resolved row carries both sides of the gap — but nothing
aggregates across rows yet. Worth naming this precisely rather than vaguely: this is a **fourth
memory kind** the three-tier model in `04-agent-infrastructure/02-agent-memory-tiers.md` doesn't
cover. It isn't working memory (it outlives the call), episodic memory (it isn't recalled by
embedding similarity), or long-term corpus memory (it isn't retrieved via `search_knowledge_base`
at all) — it's a structured record store, queried by explicit `status` and `reviewAt`, not by
relevance. Call it **decision memory**, and name the gap plainly: the record is written, but nothing
yet reads it back into the agent's own reasoning.

### Move 3 — the principle

Name the two roles a system built on an LLM can play. **Oracle**: produce the best single answer
you can, once, and hand it over. **Calibration partner**: produce an answer, but structure the
interaction so the *human's own* judgment gets scored against it — and, later, against reality —
with the system enforcing the ordering (predict before reveal) and holding the ledger (the decision
row) across the gap. Most agent systems, including buffr's own ReAct loop and the plain
`InvestingEngine` pipeline, are built as oracles. This loop is deliberately the second thing. The
score `MarketResearchEngine` computes isn't really the point — the *gap* between the human's
prediction and that score, tracked across many decisions and eventually checked against what
actually happened, is the point. That's a different product decision than "make the agent smarter":
it's "make the human's own judgment measurably better over time," and it only works because
`08`'s checkpoint enforces predict-before-reveal and `JournalStore` persists the resolution step for
whenever it eventually comes.

## Primary diagram

```
  The full loop, recapped — research-flow.ts + review-flow.ts + journal/contracts.ts

  SESSION A (t=0, /research <topic>)
  ┌────────────────────────────────────────────────────────────────────────┐
  │  predict  → PREDICTION_PROMPT, parsePrediction()      (research-flow    │
  │             :37-54)                                    .ts)             │
  │  reveal   → formatReveal(): gap + principle +          (:56-69,         │
  │             reflectionQuestion (Teacher, 01a212e)       teacher/index.ts)│
  │  promote  → saveDecision(): agents.decisions row,      (:146-159,       │
  │             status='open', reviewAt set                 session.ts)     │
  └───────────────────────────────────┬──────────────────────────────────-─┘
                                      │  ... time passes ...
  SESSION B (t=later, /review)       ▼
  ┌────────────────────────────────────────────────────────────────────────┐
  │  listDue() flips open→review-due as a side effect of listing            │
  │             (contracts.ts:61-65, pg-journal-store.ts:86-100)            │
  │  resolve  → keep / snooze / resolve(disposition, note)                  │
  │             (review-flow.ts:70-108) — human states the ground truth     │
  └────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The closest industry analog is a forecasting-calibration tournament — Tetlock's "superforecasting"
research and platforms like the Good Judgment Project and Metaculus all run this same shape:
predict, score against a reference, resolve against reality later, track the gap over many rounds.
buffr's version is a single-user, single-domain instance of that idea, applied to a solo creator's
market-research judgment instead of a geopolitical forecast.

Contrast this with reflexion / self-critique (`01-reasoning-patterns/05-reflexion-self-critique.md`)
— reflexion has the *model* critique its own output and retry, within one call. This loop has the
*human's* prediction be the thing scored, and *reality* (arriving later, out of band) be the
ultimate critic. Different axis of self-improvement entirely: reflexion tightens the model's
reasoning; this loop tightens the human's calibration. They're not competing patterns — a system
could do both, and buffr's Teacher capability sits inside the reflexion-adjacent "does this need a
critique pass" question for a different reason (producing a principle, not correcting itself).

The decision-journal *schema* (`sql/002_decision_journal.sql`, the `agents.decisions` table shape,
indexing, and migration mechanics) is a data-modeling and system-design concern owned by the sibling
`study-data-modeling` and `study-system-design` guides — this file covers only the agent-architecture
angle: what the loop is, why it closes across time instead of within one call, and what's captured
versus what isn't yet used.

## Interview defense

**Q: "How would you design a system that helps someone get better at trusting their own judgment,
not just get an answer?"**

Model answer: "Force the prediction before the reveal, and make the resolution durable so it
survives to a separate session. Concretely: `evaluate()` requires a `ResearchPrediction` as an
argument (`08`'s checkpoint), so there's no path to reveal without a captured guess. The
comparison — `scoreGap`, `dimensionMatched` — is computed in code, not asked of the model, to avoid
self-grading bias. Then I persist the pair to `agents.decisions` with a `status` lifecycle
(`open → review-due → resolved`) and a `reviewAt` date, so a *different* `/review` invocation, days
or weeks later, can surface it and ask the human what actually happened. The human's disposition —
`successful`/`unsuccessful`/`inconclusive` — is the ground truth; the system never scores its own
predictions against reality, because that would just be another guess."

**Q: "Why compute the score gap in code instead of letting the model explain how close the guess
was?"**

Model answer: "Same reason the Scorer is pure math in `07` — determinism and no self-grading. If I
asked the model 'how close was this guess,' I'd be asking it to grade a comparison it might be
motivated (or just prone) to soften. `scoreGap = actualScore - prediction.expectedScore` is
arithmetic; there's nothing to bias."

```
  The defense in one picture

  oracle          → produce the best answer, once, done
  calibration     → predict (human) → reveal (code-scored gap) → promote (persist) →
  partner (buffr)   resolve (human states reality, later, different session)
```

Anchor: *`evaluate()` requires the human's prediction as an argument, not optional (`08`); the
comparison is computed in TypeScript, never asked of the model (`engine.ts:202-208`); the loop
closes across a `status` lifecycle (`open → review-due → resolved`, `contracts.ts:3`) that survives
to a separate `/review` session, sometimes days or weeks later.*

## See also

- `08-human-in-the-loop-pipeline-checkpoint.md` — this loop's predict/reveal steps are that file's
  checkpoint; this file is what happens to the checkpoint's output over time.
- `07-typed-engine-with-capability-pipeline.md` — the Teacher capability this loop's reveal step
  depends on.
- `04-agent-infrastructure/02-agent-memory-tiers.md` — the three-tier memory model; decision memory
  is a fourth kind that file doesn't cover, cross-referenced from there too.
- `01-reasoning-patterns/05-reflexion-self-critique.md` — the model-side self-improvement loop,
  contrasted with this human-side one.
- `agent-patterns-in-this-codebase.md` — this pattern in the whole-repo table.
