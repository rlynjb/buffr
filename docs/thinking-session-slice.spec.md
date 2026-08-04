# thinking session — scope spec (v2)

feed this to claude code as the brief. it writes the implementation plan.

## what

turn the existing `/research` command into one deliberate-practice loop: the user commits a prediction *before* buffr reveals its read, sees the gap plus one principle and one reflection question, can promote the result into a tracked decision, and later resolves that decision with what actually happened.

smallest slice that proves buffr's differentiator (judgment training). not the orchestration vision.

## the loop

```
/research <topic>
      │   session drives the interaction; engine only evaluates
      ▼
engine.collect  ──►  safe digest  (source · count · titles ONLY)
      │
      ▼
session shows digest, captures ONE prediction   ← on raw evidence, pre-interpretation
      │
      ▼
engine.evaluate(prediction)  →  analyze · score · teach
      │
      ▼
session shows reveal:
      your call vs buffr  ·  computed gap  ·  predicted vs actual strongest signal
      one principle  ·  one reflection question
      │
      ▼
[discard]   [save hypothesis]   [track decision: stake + resolution + review date]
                                              │
                                              ▼
                                    decision journal ──► /review when due
                                                          resolve / snooze
```

## engine ↔ session boundary (decision, not option)

the engine is a **two-phase evaluator**. no user-interaction callback lives inside it.

- `engine.collect(input)` → returns collected evidence + a safe digest. no analysis.
- `engine.evaluate(collected, prediction)` → analyze · score · teach. returns the assessment + a computed prediction comparison.

the **session** owns everything interactive and persistent: show digest, capture prediction, show reveal, promote, write journal, run review. this makes "engine is a pure evaluator / session owns the practice loop" true instead of contradictory. (a single awaited pause-callback would work but blurs that line — rejected on purpose.)

## in scope

| piece | what it adds |
|---|---|
| two-phase engine | `collect` and `evaluate` split so the session can insert the prediction between them |
| safe digest | evidence surfaced for prediction, with a hard exclusion list (below) |
| prediction | expected opportunity score + expected strongest dimension + confidence — defined against the real rubric |
| deterministic reveal | score gap + predicted-vs-actual strongest dimension computed **in code**; teacher only narrates it |
| principle + reflection | teacher emits one transferable principle and one "what would make this worth validating" question — required, with fallbacks |
| promote gate | discard / hypothesis / decision |
| decision journal | persistence with explicit hypothesis-vs-decision kinds and a status lifecycle |
| review | nonblocking due-count at startup; `/review` lists due items |
| outcome recording | resolve a due decision as successful / unsuccessful / inconclusive + note; or snooze |

**one deliberate expansion:** outcome recording was previously deferred. it's in now. rationale: a due item with no way to act on it resurfaces forever (a bug, not a deferral), and outcomes are perishable — capturing them at review time is the only reliable moment. this records the outcome only. it does **not** score, calibrate, or analyze it.

## what the prediction is (define it, or you measure the wrong thing)

if "expected score" has no stable meaning, the comparison measures the user's familiarity with buffr's rubric, not their market judgment. so:

- **expected opportunity score**: 0–100 — same 0–100 opportunity score the engine produces
- **strongest signal**: constrained to the four real dimensions — `frequency` / `trend-velocity` / `specificity` / `monetizability` — not free text
- **confidence**: 0–100 in the UI, stored normalized to 0–1 to match the journal contract

the prompt reminds the user, in one line, what the opportunity score represents and lists the four dimensions. constraining the signal to a dimension id is also what makes the reveal deterministic.

## safe digest — explicit exclusions

the digest shown at prediction time contains only: total evidence count, and per source: source name, result count, a list of titles.

it MUST NOT contain, directly or via a field name: extracted complaints, sentiment or relevance labels, findings, dimension scores, synthesized summaries, ranking language, or any part of buffr's assessment. a field like "highly relevant complaint" leaks interpretation and breaks the whole mechanism. an acceptance test asserts no analysis fields reach the digest.

## the reveal — computed, then narrated

compute in code: score gap (actual − predicted), predicted strongest dimension, actual strongest dimension (highest-scoring finding), and whether they matched. the teacher receives these and **explains the difference** — it does not invent the comparison (a weak local model will fabricate one otherwise). reveal shows: your score, buffr's score, the numeric gap, predicted-vs-actual strongest dimension, one principle, one reflection question.

## journal model

store two kinds explicitly; don't overload one shape if it doesn't fit cleanly.

- **kind**: `hypothesis` | `decision`
- **status lifecycle**: `open` → `review-due` → `resolved` | `discarded` (snooze = reschedule the review date, back to `open`)

a **hypothesis** carries: claim, evidence ids, created-at. no stake, no review date.
a **decision** additionally carries: stake, resolution condition (measurable), review date, the user's prediction, and buffr's assessment (score + confidence) at decision time.
a **resolved** decision additionally carries: disposition (successful / unsuccessful / inconclusive) + note.

this likely means extending the status set and adding an outcome payload rather than reusing the current `DecisionJournalEntry` verbatim — that fit is a call claude code makes, but these fields are required.

## review behavior

- **startup is nonblocking**: show a quiet count ("2 decisions due for review. run /review when ready.") — never a mandatory interrupt.
- **`/review`** lists due decisions; each is actionable: keep open, snooze (reschedule), or resolve (record disposition + note).
- resolving flips status to `resolved` so it stops resurfacing.

## teacher output fallbacks

principle and reflection are required at the contract level, but the local model omits structured fields sometimes. provide deterministic fallbacks so the loop never breaks: derive the principle from the strongest metric; use a canned reflection question ("what additional evidence would make this worth validating?"). the reveal always has both.

## out of scope (deferred — build in this order, once resolved outcomes accrue)

1. finding-support check (does each finding's evidence actually back the claim), run before synthesis, cost-sampled
2. strong-judge provider (anthropic behind the existing model interface) where grading/teaching quality matters
3. calibrator (brier-score predicted confidence vs realized outcome; drift detection) — reads the outcomes this slice records
4. extract a reusable decision-session layer other engines share
5. fitness dashboard (a read over calibrator output; never render scores under ~10 resolved entries)

outcome *recording* is in this slice; outcome *scoring* is not. that line is the whole discipline here.

## decisions that bound the build

- **two-phase engine, session owns interaction.** no UI callback inside the engine.
- **predict on raw evidence, against the real rubric.** digest excludes all interpretation; the prediction targets the opportunity score and one of the four dimensions.
- **one prediction, not a prior/post pair.** add the belief-update version later only if the single prompt gets used.
- **the comparison is computed, the teacher narrates.** never let the model fabricate the gap.
- **a decision requires a stake and a measurable resolution condition.** without both it's a hypothesis. only decisions get a review date.
- **default disposition is discard.** the journal stays signal, not log.
- **record outcomes now, score them never (this slice).** perishable data in; calibration out.

## where it plugs in (orientation, not instruction)

**modified:** `MarketResearchEngine` (split into collect / evaluate; return the strongest-metric data the comparison needs) · `Teacher` (one principle + one reflection question, with fallbacks) · `ChatSession` (coordinate prediction, reveal, promotion, journal writes, review) · `chat.tsx` (render the interactive steps) · startup flow (nonblocking due-count).

**new:** `JournalStore` interface + in-memory (dev/tests) + pg (prod), mirroring the existing vector-store split · `decision_journal` table · evidence-digest and prediction-comparison types · outcome/disposition on resolution.

**unchanged:** collector · analyzer · scorer · retrieval · tracing · domain scorecard.

## done means

- `/research <topic>` collects evidence before asking for a prediction
- prediction-time output contains no findings, interpretation, or score
- the user records: expected opportunity score, expected strongest dimension, confidence
- analysis output is not revealed until a prediction exists
- reveal shows: user score, buffr score, numeric gap, predicted vs actual strongest dimension, one principle, one reflection question
- default disposition is discard
- a hypothesis persists without a stake or review date
- a decision requires a stake, a measurable resolution condition, and a review date
- journal persistence survives session restart
- startup shows a nonblocking count of due decisions; `/review` lists them
- a due decision can be snoozed or resolved (disposition + note), and resolving stops it resurfacing
- cancelling during prediction creates no partial journal entry
- existing `/research` scoring and eval tests still pass
- a new test proves no analysis fields leak into the prediction digest
- no workflow-definition or orchestration framework is introduced
