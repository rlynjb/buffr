# 09 — Predict-Then-Reveal Loop

**Subtitle:** Calibration-training loop (blind commitment before feedback) — Project-specific system flow, spanning a two-phase engine call, two CLI state machines, and a durable decision journal.

---

## Zoom out

`/research` is not "run an engine and print the result." It's the one place in this repo where the *user's own judgment* is part of the data. Before buffr shows a single number, it makes you commit to one — then it doesn't let the comparison evaporate the moment you close the terminal. It writes the gap down and comes back to ask what actually happened.

```
  Zoom out — where the predict-then-reveal loop lives

  ┌─ UI layer ────────────────────────────────────────────────────────────┐
  │  chat.tsx: /research <topic>, /review     ★ THIS LOOP SPANS HERE ★     │
  └────────────────────────────┬─────────────────────────────────────────┘
                               │ drives
  ┌─ CLI flow layer ───────────▼────────────────────────────────────────┐
  │  research-flow.ts: predict → reveal → promote  ★ AND HERE ★          │
  │  review-flow.ts:   surface due → keep/snooze/resolve  ★ AND HERE ★   │
  └────────────────────────────┬─────────────────────────────────────────┘
                               │ calls
  ┌─ Engine layer ─────────────▼────────────────────────────────────────┐
  │  MarketResearchEngine.collect() / .evaluate()   ★ AND HERE ★         │
  └────────────────────────────┬─────────────────────────────────────────┘
                               │ persists via
  ┌─ Adapter/Storage layer ────▼────────────────────────────────────────┐
  │  JournalStore (PgJournalStore) → agents.decisions   ★ AND HERE ★     │
  └───────────────────────────────────────────────────────────────────────┘
```

Four layers, one continuous flow. That's the point of this file: `00-overview.md` shows each layer as a box; `07`/`08` show the capability pipeline and the engine split as their own patterns; this file is the one that walks the *thread* connecting all four, because none of the other files tells that story end to end.

**Zoom in.** The industry name for the core move is **calibration training** — the practice (from forecasting research, popularized by Philip Tetlock's *superforecasting* work) of writing down a numeric prediction *before* you get feedback, so you can measure how well-calibrated your gut is instead of quietly hindsight-rationalizing after the fact. buffr's `/research` does exactly this for market-research topics: predict a score and dimension, then see buffr's number and the gap. The system carries it one step further than a one-off calibration exercise — a prediction can be *promoted* to a tracked decision with a stake and a review date, which is where this stops being a forecasting game and starts being a decision journal (a practice borrowed from investing and product discipline: write down what you're betting, why, and when you'll check).

---

## Structure pass

**Layers.** Four, matching the zoom-out diagram: CLI flow (state machine, ephemeral per-command), engine (two-phase, stateless between calls), journal port/adapter (durable), storage (Postgres `agents.decisions`).

**The axis worth tracing: who owns the "am I done yet" decision?**

```
  One axis, four layers — "who decides what happens next?"

  chat.tsx           → the USER decides which slash command to type
  research-flow.ts   → CODE decides the step order (prediction→promote→
                        stake→resolution→review-date), but the USER's answer
                        at each step decides which branch (discard/hypothesis/
                        decision) and supplies every value written to storage
  MarketResearchEngine → CODE decides collect() then evaluate(), no branching
                        — the SPLIT POINT exists only because the USER needs
                        to act between the two calls
  JournalStore         → CODE decides the status transitions (open→
                        review-due happens automatically at listDue() time,
                        based on a clock comparison, not a human decision)
```

The interesting flip: control is human-driven in the flow layer (every branch is a user answer) and clock-driven in the storage layer (the `review-due` transition fires from `review_at <= now`, nobody asks). The seam between them — `review-flow.ts` calling `listDue()` — is where a background, time-based fact ("this is due") gets handed back to a human for a decision again. That handoff is the loop closing.

**Seams that matter:**
- **`collect()` / `evaluate()` split** (engine boundary, detailed in `08-domain-pack-and-engine.md`) — the seam where evidence-gathering (no LLM, no user judgment needed) hands off to analysis (LLM-driven, requires the prediction already captured). The load-bearing property crossing this seam: **no code path can call `evaluate()` without a `ResearchPrediction` already in hand** — the type signature makes hindsight-informed prediction structurally impossible, not just discouraged by convention.
- **`JournalStore` port** (`packages/kernel/src/journal/contracts.ts`) — the seam between the flow layer and durability. `PgJournalStore` and `InMemoryJournalStore` are two adapters behind one contract, the same port/adapter shape `01-vector-store-adapter.md` covers for `VectorStore` — see that file for the port/adapter vocabulary; this file doesn't re-teach it.
- **`listDue()`'s side effect** — the one seam in this loop where a *read* (`listDue`) silently performs a *write* (the `open → review-due` transition). That's unusual enough to be a designed contract, not an oversight: the doc comment on `JournalStore` (`contracts.ts:61-66`) makes it explicit and requires both adapters to do it identically. `41ecce8` fixed a real bug where `InMemoryJournalStore` did it *without* scoping by user/workspace — see this file's Interview defense and `audit.md` lens 8 for that as a case study in what happens when an implicit contract isn't type-enforced.

---

## How it works

### Move 1 — the mental model

You already know the shape from something more mundane: a **blind guess before you look at the answer key**. Every quiz app that shows you the question, takes your answer, *then* reveals the correct one is doing the same kernel move buffr does here — except buffr's "answer key" is an LLM-scored analysis, and instead of just grading you, it optionally turns the miss (or hit) into a dated commitment you'll be asked about again.

```
  The loop's shape — five states, one direction, with an optional persistent tail

  ┌──────────┐   evidence    ┌───────────┐   comparison  ┌──────────┐
  │ COLLECT  │──gathered────►│  PREDICT  │──computed────►│  REVEAL  │
  │(no LLM)  │  (digest only,│(user commits│(Analyzer→    │(gap shown,│
  │          │   no analysis)│ blind)     │ Scorer→Teacher)│ code-only)│
  └──────────┘               └───────────┘                └────┬─────┘
                                                                 │ user chooses
                                       ┌─────────────────────────┼─────────────────┐
                                       ▼                         ▼                 ▼
                                 discard                   hypothesis          decision
                                 (nothing saved)        (JournalStore.create   (+ stake, resolution,
                                                          kind:'hypothesis')    review date →
                                                                                JournalStore.create
                                                                                kind:'decision')
                                                                                       │
                                                                          time passes, review_at <= now
                                                                                       ▼
                                                                              ┌─────────────┐
                                                                              │ REVIEW-DUE  │
                                                                              │ (surfaced by │
                                                                              │ /review)     │
                                                                              └──────┬───────┘
                                                                     keep │ snooze │ resolve
                                                                          ▼    ▼         ▼
                                                                    (stays) (new    (disposition +
                                                                            review_at) note recorded,
                                                                                    status='resolved')
```

The kernel — the part that makes this *calibration training* and not just "an analysis tool with a save button" — is the **COLLECT → PREDICT → REVEAL** spine. Everything after REVEAL (promote/track/review) is what turns a one-off calibration exercise into an accountability loop, but the calibration mechanic itself lives entirely in those first three states.

### Move 2 — the step-by-step walkthrough

#### Step 1 — collect (evidence with no opinion attached)

`research-flow.ts`'s `start()` (`src/cli/research-flow.ts:82-90`) calls `session.researchCollect(topic, ...)`, which calls `MarketResearchEngine.collect()` (`packages/engines/market-research/src/engine.ts:56-117`, walked in depth in `08-domain-pack-and-engine.md`). The only thing that reaches the terminal at this point is `formatDigest()` (`research-flow.ts:25-35`) — source name, count, and evidence *titles*, nothing interpreted:

```typescript
// research-flow.ts:25-35 — what the user sees before predicting
function formatDigest(topic: string, collected: CollectedResearch): string {
  const lines = [`Collected evidence for "${topic}" — ${collected.digest.totalCount} result(s):`, ''];
  for (const source of collected.digest.sources) {
    lines.push(`${source.source} (${source.count}):`);
    for (const title of source.titles) lines.push(`  • ${title}`);
  }
  return lines.join('\n');
}
```

If `digest.totalCount === 0`, the flow ends right here (`research-flow.ts:85-88`) — no prediction is even asked for, because there's nothing to predict against. This mirrors the "no LLM calls on empty evidence" invariant from `07-capability-pipeline.md`; it just moved to a different layer since the split put the empty-check before the caller decides whether to proceed at all.

```
  Layers-and-hops — collect() phase

  ┌─ chat.tsx ──────┐ /research topic  ┌─ research-flow.ts ─┐
  │ user types      │ ───────────────► │ start()             │
  └─────────────────┘                  └──────────┬──────────┘
                                                    │ session.researchCollect(topic)
                                                    ▼
                                         ┌─ session.ts ────────┐
                                         │ researchCollect()   │
                                         └──────────┬──────────┘
                                                    │ engine.collect(input, ctx)
                                                    ▼
                                    ┌─ MarketResearchEngine ──┐
                                    │ collect(): Collector    │
                                    │ per source, Promise.all │
                                    └──────────┬──────────────┘
                        ProgressEvent stream ◄─┤  (connector-start/done/failed)
                                               │ CollectedResearch{evidence, digest}
                                               ▼
                                  back up through session → flow → chat.tsx
                                  formatDigest() renders titles only
```

#### Step 2 — predict (the blind commitment)

`PREDICTION_PROMPT` (`research-flow.ts:37-42`) asks for `<score 0-100> <dimension> <confidence 0-100>`. `parsePrediction()` (`research-flow.ts:44-54`) validates the shape — score and confidence in range, dimension one of the four `MARKET_RESEARCH_DIMENSIONS` ids — and rejects anything malformed with a re-prompt rather than a crash or a silent default. This is the one step in the whole loop where the user, not buffr, produces the value that matters most: nothing upstream of this line has told the user anything the model concluded.

```typescript
// research-flow.ts:44-54
function parsePrediction(input: string): ResearchPrediction | null {
  const parts = input.trim().split(/\s+/);
  if (parts.length !== 3) return null;
  const [scoreStr, dimension, confidenceStr] = parts;
  const score = Number(scoreStr);
  const confidence = Number(confidenceStr);
  if (!Number.isFinite(score) || score < 0 || score > 100) return null;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) return null;
  if (!VALID_DIMENSIONS.includes(dimension as Dimension)) return null;
  return { expectedScore: score, expectedDimension: dimension as Dimension, confidence: confidence / 100 };
}
```

Once parsed, `submit()` immediately calls `session.researchEvaluate(collected, prediction)` (`research-flow.ts:104`) — the prediction is captured in a local closure variable and never touches storage until (and unless) the user chooses to promote it in step 4. If the user never gets past `discard`, the prediction simply evaporates with the rest of the flow's state. Calibration happens whether or not anything is saved — the write-to-disk is a separate, later decision.

#### Step 3 — reveal (the comparison, computed in code)

`evaluate()` runs Analyzer→Scorer→Teacher (walked stage-by-stage in `07-capability-pipeline.md`) and, critically, builds the `PredictionComparison` itself rather than asking the model to grade the user (`engine.ts:199-208`, covered from the engine's own point of view in `08-domain-pack-and-engine.md`). `formatReveal()` (`research-flow.ts:56-69`) is what the user actually reads:

```typescript
// research-flow.ts:56-69
function formatReveal(output: MarketResearchOutput): string {
  const c = output.comparison;
  const matchLine = c.dimensionMatched
    ? `Dimension match: yes — both picked ${c.actualDimension}.`
    : `Dimension match: no — you picked ${c.prediction.expectedDimension}, strongest was ${c.actualDimension}.`;
  const gapSign = c.scoreGap >= 0 ? '+' : '';
  return [
    `Your call: ${c.prediction.expectedScore}   buffr: ${Math.round(output.summary.totalScore)}   gap: ${gapSign}${c.scoreGap.toFixed(0)}`,
    matchLine, '',
    `Principle: ${output.summary.principle}`,
    `Reflect: ${output.summary.reflectionQuestion}`,
  ].join('\n');
}
```

Both `principle` and `reflectionQuestion` come from the Teacher capability addition covered in `07-capability-pipeline.md` — this is the step where that addition actually reaches the user, right after the numeric gap. The reveal is the payoff of the whole calibration exercise: a specific, numeric answer to "how far off was your gut," not a vague "pretty close" the user could rationalize away.

#### Step 4 — promote (discard / hypothesis / decision)

`PROMOTE_PROMPT` (`research-flow.ts:71`) branches three ways (`research-flow.ts:110-126`). `discard` ends the flow with nothing written. `hypothesis` calls `session.saveHypothesis()` → `journalStore.create({ kind: 'hypothesis', ... })` (`session.ts:745-757`) — a lightweight claim record with no stake, no review date, nothing to come back to. `decision` is the heavier path: three more sequential prompts — stake ("what will you actually do, and what do you risk"), resolution condition ("what measurable outcome would prove this right or wrong"), and review date (parsed by the shared `parseDayCountOrDate()`, `src/cli/parse-review-date.ts`, accepting either a bare day-count like `"30"` or an ISO date) — before `saveDecision()` writes a full `JournalEntry` with both the `prediction` and the `assessment` (the engine's `totalScore`/`confidence`) captured side by side (`session.ts:758-783`, schema in `sql/002_decision_journal.sql:1-25`).

The `hypothesis` vs `decision` distinction is a real fork, not cosmetic: a hypothesis is "I noticed this," a decision is "I am staking something on this and will check back." Only decisions carry a `review_at` and therefore only decisions can ever become `review-due` — `listDue()` filters on `kind = 'decision'` explicitly (`in-memory-journal-store.ts:39-49`, `pg-journal-store.ts:86-92`).

#### Step 5 — track (durable, behind a port)

`JournalStore.create()` is where a decision stops being process state and becomes a row. `PgJournalStore.create()` (`src/pg-journal-store.ts:50-84`) inserts into `agents.decisions` with `status='open'` — the prediction (`predicted_score`/`predicted_dimension`/`predicted_confidence`) and the assessment (`assessed_score`/`assessed_confidence`) are stored as separate column groups rather than collapsed into one, specifically so the review flow can show both side by side later without re-deriving anything (`review-flow.ts:17-23`'s `formatEntry()` prints exactly that pair).

#### Step 6 — review (the loop closes)

`/review` calls `session.listDueReviews()` → `journalStore.listDue(userId, workspaceId, now)`. This is the seam flagged in the structure pass: `listDue()` is a read with a write side effect — any `open` decision whose `review_at <= now` flips to `review-due` as part of being listed (`contracts.ts:61-66` doc comment; both adapters implement it, `pg-journal-store.ts:86-92` via an `update ... where` before the `select`, `in-memory-journal-store.ts:37-49` via a loop before the filter). `review-flow.ts` then walks the due list one entry at a time, each resolved via `keep` (advance, no change), `snooze` (`parseDayCountOrDate()` → status back to `open` with a new `review_at` — the loop doesn't end, it just gets a later date), or `resolve` (a `disposition` — successful / unsuccessful / inconclusive — plus a free-text note, terminal state).

```
  Layers-and-hops — the review phase, closing the loop

  ┌─ chat.tsx ──┐  /review   ┌─ review-flow.ts ──┐  listDueReviews()  ┌─ session.ts ─┐
  │ user types  │──────────► │ start()            │──────────────────►│              │
  └─────────────┘            └─────────┬──────────┘                  └──────┬───────┘
                                        │ formatEntry() shows                │ journalStore.listDue()
                                        │ predicted vs assessed              ▼
                                        │                          ┌─ PgJournalStore ──┐
                                        │                          │ UPDATE ... SET     │
                                        │                          │ status='review-due'│
                                        │                          │ WHERE review_at<=now│
                                        │                          │ SELECT * WHERE      │
                                        │                          │ status='review-due' │
                                        │                          └──────────┬──────────┘
                                        │                                     │
                              keep/snooze/resolve ◄─────── formatEntry() ◄───┘
```

### Move 3 — the principle

The general lesson generalizes past this repo: **any system that wants to measure judgment, not just produce an answer, has to force the commitment before the reveal — and if the commitment is worth anything, it has to survive past the terminal session that produced it.** A prediction nobody wrote down is not calibration, it's a feeling. A tracked decision nobody comes back to is not accountability, it's a to-do list. The `collect()`/`evaluate()` split buys the first half (structurally impossible to predict in hindsight); the `JournalStore` + `/review` loop buys the second half (structurally impossible to forget, once `review_at` passes). Neither half alone is the pattern — it's the combination that makes this a *loop* instead of a one-shot feature.

---

## Primary diagram

```
  Predict-then-reveal loop — full system, every hop labelled

  ┌─ UI (chat.tsx) ───────────────────────────────────────────────────────────┐
  │  /research <topic>                                    /review             │
  └──────┬──────────────────────────────────────────────────────┬────────────┘
         │ new ResearchFlow                                     │ new ReviewFlow
         ▼                                                       ▼
  ┌─ research-flow.ts ────────────────┐              ┌─ review-flow.ts ────────┐
  │ step: prediction                   │              │ step: action             │
  │  start() → researchCollect(topic) ─┼──┐           │  start() → listDueReviews│
  │  digest shown, PREDICTION_PROMPT   │  │           │  formatEntry() shown      │
  │ step: promote                      │  │           │ step: snooze-date/        │
  │  submit(answer) → researchEvaluate │  │           │       disposition/note    │
  │  formatReveal() shown              │  │           │  → snoozeReview/          │
  │ step: stake/resolution/review-date │  │           │    resolveReview          │
  │  → saveHypothesis / saveDecision   │  │           └─────────┬─────────────────┘
  └───────┬─────────────────────────────┘  │                     │
          │                                │                     │
          ▼                                ▼                     ▼
  ┌─ session.ts (researchCollect/Evaluate, saveHypothesis/Decision, listDueReviews, snoozeReview, resolveReview) ─┐
  └───────┬─────────────────────────────────────────────────────────────────────────────┬────────────────────────┘
          │ engine.collect() / engine.evaluate()                                        │ journalStore.*
          ▼                                                                              ▼
  ┌─ MarketResearchEngine ─────────────────────┐                          ┌─ PgJournalStore (JournalStore port) ─┐
  │  collect(): Collector only → CollectedResearch│                        │  create / listDue (+ side effect) /  │
  │  evaluate(collected, prediction): Analyzer→   │                        │  snooze / resolve                    │
  │  Scorer→Teacher → comparison built IN CODE    │                        └──────────────┬────────────────────────┘
  └───────────────────────────────────────────────┘                                       │
                                                                                            ▼
                                                                          ┌─ Postgres agents.decisions ───────────┐
                                                                          │  predicted_*/assessed_*/stake/         │
                                                                          │  resolution_condition/review_at/status │
                                                                          └────────────────────────────────────────┘
```

---

## Elaborate

The predict-then-reveal half of this pattern is a direct application of forecasting-calibration research (Tetlock's superforecasters keep exactly this kind of prediction-then-observation log; Kaggle-style ML competitions enforce the same blind-then-reveal structure so a model's score can't be gamed by peeking). The promote-then-review half is closer to the "decision journal" practice from investing and product discipline — write your thesis, your stake, and your falsification condition down *before* the outcome is known, because memory reliably rewrites itself to make past decisions look more reasoned than they were. buffr's contribution is wiring both halves into one continuous system flow instead of leaving them as separate manual habits: the engine's type signature enforces the blind part, and the `JournalStore` + `review_at` clock enforces the follow-through part.

Where this connects to the rest of the guide: the engine-level mechanics of the split live in `08-domain-pack-and-engine.md`; the capability-level mechanics of Analyzer/Scorer/Teacher live in `07-capability-pipeline.md`; the port/adapter vocabulary this file leans on for `JournalStore` is taught in full in `01-vector-store-adapter.md`. If a third domain ever needs the same "commit before you see the answer" shape (a habit tracker predicting adherence, a workout planner predicting a PR), the reusable piece to copy is the engine split plus a `JournalStore`-shaped port — not a new subsystem from scratch.

---

## Interview defense

**"Walk me through what happens between typing `/research some topic` and buffr showing a score."**

Two engine calls, not one, with the user in between. `research-flow.ts` calls `researchCollect()`, which runs `MarketResearchEngine.collect()` — Collector only, evidence and a title-only digest, zero LLM calls. That digest is shown to the user, who is then asked to predict a score, dimension, and confidence *before* anything is analyzed. Only after that prediction is captured does `research-flow.ts` call `researchEvaluate()`, which runs `MarketResearchEngine.evaluate()` — Analyzer→Scorer→Teacher — and computes the comparison against the stored prediction in code, never by asking the model. → primary diagram above, left half.

**"What's the load-bearing part someone would forget if they tried to rebuild this?"**

That `evaluate()` requires a `CollectedResearch` and a `ResearchPrediction` as arguments — there is no code path that produces a `MarketResearchOutput` without a prediction already having been captured first. Drop that constraint (say, by making the prediction optional or letting `evaluate()` run standalone) and the entire calibration-training premise collapses: the user could always predict *after* seeing hints of the answer, and the "gap" would stop meaning anything. The second load-bearing part, easy to skip on a rebuild: `listDue()`'s side effect. If the `open → review-due` transition weren't scoped by `userId`/`workspaceId` — the exact bug `41ecce8` fixed in `InMemoryJournalStore` (`in-memory-journal-store.ts:37-49`, matching `PgJournalStore`'s `WHERE app_id = $1 AND user_id = $2 AND workspace_id = $3`) — a review call scoped to one user could silently flip another user's decision to due. The contract's own doc comment (`contracts.ts:61-66`) says "both implementations must do this identically" precisely because nothing in the type system enforces it; only a matching test on both adapters does.

**"Why compute the comparison in code instead of asking the LLM 'was the user close'?"**

Because the LLM has every incentive (from training on agreeable, hedging text) to be generous — "that's roughly in the ballpark!" — which defeats the entire point of calibration training. `scoreGap` is `actualScore - prediction.expectedScore`, plain subtraction; `dimensionMatched` is a string equality check against the highest-scoring finding. Neither can be talked into a softer answer. The one place this gets interesting is the degenerate case: if the Analyzer returns zero findings, there's no "strongest finding" to compare against, so `dimensionMatched` is hard-coded `false` and `actualDimension` is `'unknown'` rather than crashing on an empty-array reduce — a real bug closed in `41ecce8`, now covered by a dedicated test (`engine.test.ts`, "zero findings: does not throw").

---

## See also

- `07-capability-pipeline.md` — Analyzer/Scorer/Teacher, and the Teacher's `principle`/`reflectionQuestion` fields this loop surfaces at reveal time.
- `08-domain-pack-and-engine.md` — the `collect()`/`evaluate()` engine split, from the engine's point of view.
- `01-vector-store-adapter.md` — the port/adapter vocabulary this file leans on for `JournalStore`/`PgJournalStore`/`InMemoryJournalStore`.
- `00-overview.md` — flows 6 and 8, the short version of this same walk in the whole-system context.
- `audit.md` lens 8 — the `41ecce8` integration-seam bugs as a red-flags case study.
- `packages/kernel/src/journal/contracts.ts`, `src/pg-journal-store.ts`, `packages/kernel/src/journal/in-memory-journal-store.ts` — the port and its two adapters.
- `src/cli/research-flow.ts`, `src/cli/review-flow.ts`, `src/cli/parse-review-date.ts` — the source of record for the state machines.
- `sql/002_decision_journal.sql` — the `agents.decisions` schema.
