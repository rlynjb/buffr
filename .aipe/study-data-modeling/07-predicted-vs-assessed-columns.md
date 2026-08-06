# Predicted vs. assessed columns (forecast/actual pair)

**Industry name(s):** forecast-vs-actual columns / predicted-vs-observed pair —
here `predicted_score`/`predicted_dimension`/`predicted_confidence` beside
`assessed_score`/`assessed_confidence` on `agents.decisions`. **Type:**
Industry standard (the same shape as budgeted-vs-actual in finance and
ops schemas), applied to a personal decision journal.

---

## Zoom out, then zoom in

You just read `05-text-stored-twice.md` — the chunk's text living in two
columns, same value, one of them dead weight at read time. This file looks
like the same move at first glance: two column families about one row. It
isn't. This is the new `agents.decisions` table (`sql/002_decision_journal.sql`,
landed in `699e77b`), and the two column families hold **different** values on
purpose — your guess, captured before you see any analysis, and the engine's
score, computed after. Neither is a copy of the other. Telling these two
patterns apart is the whole lesson.

```
  Zoom out — where the twin columns live

  ┌─ CLI (research-flow.ts) ─────────────────────────────────┐
  │  1. show raw evidence, no analysis yet                     │
  │  2. ask user to predict          ── PREDICTION_PROMPT      │
  │  3. run the scoring engine       ── reveals its own number │
  │  4. show both, plus the gap                                │
  └───────────────────────────────┬─────────────────────────────┘
                                  │  session.saveDecision(...)
  ┌─ Postgres (agents.decisions) ─▼───────────────────────────┐
  │  predicted_score / predicted_dimension / predicted_confidence│ ← user, t0
  │  assessed_score / assessed_confidence                      │ ← engine, t1
  └────────────────────────────────────────────────────────────┘
```

Zoom in: the question this table answers is "was your gut right?" — and you
can't answer that if you only keep one number. You need the guess *and* the
outcome, sitting side by side, so the gap between them is a query away
instead of something you have to remember.

---

## The structure pass

```
  One axis: "is this a duplicate fact, or two different facts?"

  ┌─ chunks.content / chunks.meta.text (05) ───────────────────┐
  │  SAME string, written together, one statement               │  duplicate
  │  read path picks ONE winner (content) — the other is dead   │  → 05
  └───────────────────────────────────────────────────────────────┘
                            ╎  seam: are the two values ever equal on purpose?
  ┌─ decisions predicted_* / assessed_* (here) ─────────────────┐
  │  DIFFERENT values, different authors, different moments      │  two facts
  │  a match (predicted ≈ assessed) is a finding, not the norm   │  → here
  │  both are read together — neither is thrown away             │
  └───────────────────────────────────────────────────────────────┘
```

The axis is **duplicate fact vs. two distinct facts about the same subject**.
`05-text-stored-twice.md` sits on one side: the two copies are supposed to be
identical, and when they diverge that's a bug (information leakage — the same
fact editable in two places). This table sits on the other side: the two
column families are supposed to be able to disagree — the disagreement (the
"gap") is the *product*. Normalization's rule ("store each fact once") isn't
violated here at all, because `predicted_score` and `assessed_score` are two
different facts, each stored exactly once. That's the seam that makes this a
different pattern, not a repeat of 05.

---

## How it works

### Move 1 — the mental model

You've built forms with a "planned" field and an "actual" field before — a
budget line with `budgeted_amount` and `actual_amount`, a sprint estimate
next to the hours actually logged. Nobody calls that duplication; the two
numbers are allowed, expected, even, to differ. `predicted_score` /
`assessed_score` is that pattern, with a twist: the "planned" side is a
*human's* guess and the "actual" side is a *model's* score, and the row is
written once, after both already exist — there's no window where only one
side is populated.

```
  Forecast/actual — two authors, two moments, one row

  t0: user predicts        t1: engine assesses       t2: one row, both kept
  ┌──────────────┐         ┌──────────────┐          ┌────────────────────┐
  │ 72, frequency,│         │ 58, conf 0.7 │   ──►    │ predicted_score: 72 │
  │ confidence 60 │         │ (computed)   │          │ assessed_score:  58 │
  └──────────────┘         └──────────────┘          │ gap: -14 (derived,  │
                                                       │  not stored)        │
                                                       └────────────────────┘
```

### Move 2 — the walkthrough

**The schema declares two parallel, independently-nullable column
families.** `sql/002_decision_journal.sql:17-21`:

```sql
-- sql/002_decision_journal.sql:17-21
predicted_score numeric,            -- the user's guess, before the reveal
predicted_dimension text,
predicted_confidence numeric,
assessed_score numeric,             -- the engine's score, computed after
assessed_confidence numeric,
```

No `not null` on either side — both families are optional at the table level
because `kind = 'hypothesis'` rows never populate either one
(`pg-journal-store.ts:62-66`, the `decisionFields` object is all-`null` for a
hypothesis). Only `kind = 'decision'` rows carry both. That's a second,
smaller pattern riding along here: this table reuses the same
discriminated-nullable-family move `chunks` uses to hold retrieval chunks
*and* memory chunks in one table (`01-vector-column-and-ann-index.md`,
`06-trajectory-tables.md`) — a `kind` column decides which optional column
family is "live" for a given row. Same shape, different discriminator (`kind`
here vs. `meta.kind`/id-prefix on `chunks`). Worth recognizing once you've
seen it in one place.

**Both sides are captured before the row is ever written — not as an
update-later pattern.** This is the detail that separates it from something
that *looks* similar but isn't (a status flag you flip after the fact). The
research flow runs the prediction and the engine strictly in sequence, and
the row is inserted only once, with both values already in hand:

```ts
// src/cli/research-flow.ts:95-107 (condensed)
if (step === 'prediction') {
  const parsed = parsePrediction(input);          // user's guess, from raw evidence only
  prediction = parsed;
  const { output: o } = await session.researchEvaluate(collected, prediction, callbacks); // engine scores
  output = o;                                       // assessed_score arrives HERE
  step = 'promote';
  return { messages: [formatReveal(output), PROMOTE_PROMPT], step };
}
```

```ts
// src/session.ts:758-780 (condensed) — saveDecision, called only after both exist
await journalStore.create({
  kind: 'decision',
  ...
  prediction: input.prediction,                     // predicted_* columns
  assessment: input.assessment,                      // assessed_* columns
}, now);
```

The user predicts *before* seeing the engine's number — `formatDigest`
shows raw evidence, no analysis, and `PREDICTION_PROMPT` asks for a call
before any score is revealed (`research-flow.ts:82-90`). That ordering is
the whole point: if the user could see the assessed score first, the
predicted column would just be a copy of it, and you'd be back to
`05-text-stored-twice.md`'s pattern by accident. The UI enforces the
independence that makes the two columns meaningful.

**The gap is computed, not stored.** Nothing in the schema holds
"predicted minus assessed." It's derived at display time:

```ts
// src/cli/research-flow.ts:56-63 (formatReveal)
const c = output.comparison;
const gapSign = c.scoreGap >= 0 ? '+' : '';
return [
  `Your call: ${c.prediction.expectedScore}   buffr: ${Math.round(output.summary.totalScore)}   gap: ${gapSign}${c.scoreGap.toFixed(0)}`,
  ...
```

That's the correct call — the gap is a *derived* fact (predicted − assessed),
and derived facts don't get their own column unless you need to index or
aggregate on them. Nothing here queries "all decisions with a gap > 20," so
storing it would just be a third copy of information the other two columns
already carry, with the same staleness risk `05` warns about. If that query
ever shows up, computing the gap in SQL (`predicted_score - assessed_score`)
is cheaper than adding a column that could drift.

**The boundary condition — the two sides can never be reconciled into one
"true" value, and that's correct.** Unlike `05`, where `content` is
declared the winner on read, there's no "winner" here. `predicted_score`
stays the user's number forever; `assessed_score` stays the engine's number
forever. The row doesn't get rewritten to make them agree. If you tried to
apply `05`'s discipline here — "pick one column as the source of truth and
stop writing the other" — you'd destroy the thing the table exists to
capture. That's the tell for recognizing this pattern versus a duplication:
**ask whether collapsing the two columns into one would lose information.**
In `05`, collapsing to `content` loses nothing (that's literally what the
read path already does). Here, collapsing to either column loses the
prediction *or* the outcome — the entire reason the table exists.

```
  The test that tells the two patterns apart

  05 (text stored twice):        07 (predicted vs assessed):
  collapse to ONE column?        collapse to ONE column?
  → lose nothing (read already   → lose the prediction OR the
    does this)                     outcome — the whole point
  = duplication (accidental-      = two distinct facts
    shaped, deliberate use)         (correctly normalized)
```

**`stake` and `resolution_condition` stay free text; `review_at` is
structured — and that split tracks who reads the field.** Two of the three
follow-up fields are `text` with no constraint:

```sql
-- sql/002_decision_journal.sql:14-16
stake text,                    -- "what will you actually do, what do you risk"
resolution_condition text,     -- "what measurable outcome proves this right/wrong"
review_at timestamptz,         -- WHEN to check back — the one the DB has to compare
```

`stake` and `resolution_condition` are read by a human, once, in
`review-flow.ts`'s `formatEntry` (`review-flow.ts:17-23`) — the database
never filters, sorts, or compares on their contents, so structuring them
would buy nothing but friction on a CLI prompt that's explicitly free-form
("what will you actually do, and what do you risk if you're wrong?",
`research-flow.ts:123`). `review_at` is the opposite: `PgJournalStore.listDue`
does `where ... review_at <= $4` (`pg-journal-store.ts:88-91`) — a real
comparison the database has to execute, so it has to be a comparable type.
The rule: structure a field the *query planner* touches; leave free text
alone when only a human eye ever reads it.

### Move 3 — the principle

Two columns holding what looks like "the same kind of value" are not
automatically a normalization problem — the question is whether they're
allowed to disagree on purpose. `05-text-stored-twice.md` is a real
duplication: one fact, two addresses, a designated winner, a staleness risk
if a second writer ever appears. This table is the opposite of that: two
distinct facts (a forecast and an outcome), captured by two different
authors at two different times, kept side by side *because* their
disagreement is the signal you're trying to measure. Reach for the twin-column
shape whenever you need to compare a claim against reality later — a
budget, an estimate, a hypothesis, a bet — and reach for `05`'s discipline
only when the two copies are actually meant to be identical.

---

## Primary diagram

```
  Predicted vs. assessed — capture order, storage, and what's derived

  ┌─ t0: raw evidence shown, no score yet ───────────────────┐
  │  research-flow.ts:82-90  PREDICTION_PROMPT                │
  └───────────────────────────────┬─────────────────────────────┘
                                  │  user answers BLIND
  ┌─ predicted_* (the guess) ─────▼───────────────────────────┐
  │  predicted_score · predicted_dimension · predicted_confidence│
  └───────────────────────────────┬─────────────────────────────┘
                                  │  THEN the engine runs
  ┌─ assessed_* (the outcome) ────▼───────────────────────────┐
  │  assessed_score · assessed_confidence                      │
  └───────────────────────────────┬─────────────────────────────┘
                                  │  journalStore.create() — ONE insert,
                                  │  both families already populated
  ┌─ agents.decisions row ────────▼───────────────────────────┐
  │  both kept forever, no winner declared                    │
  │  gap = predicted_score - assessed_score  ── DERIVED,       │
  │  computed in research-flow.ts, never stored                │
  └────────────────────────────────────────────────────────────┘
```

---

## Elaborate

This is the same shape as `budgeted_amount`/`actual_amount` on a finance
ledger, `estimated_hours`/`logged_hours` on a project-tracking schema, or a
weather model's `forecast_temp`/`observed_temp`. The industry name varies by
domain (forecast/actual, planned/actual, expected/observed) but the schema
move is identical: two nullable column families, captured at two different
times, deliberately never merged. What makes buffr's version worth studying
is the *ordering discipline* — the app enforces that the prediction is
captured before the assessment is revealed, which is what keeps the two
columns honest. A twin-column schema with no such ordering guarantee (nothing
stops someone from filling in "predicted" after seeing "assessed") is just a
form with two boxes; the value of the pattern lives in the process around the
schema, not the schema alone.

The self-similar discriminator move — one `kind` column deciding which
optional column family applies to a row — is the same trick `chunks` plays
with `meta.kind='memory'` (`01-vector-column-and-ann-index.md`,
`06-trajectory-tables.md`). Seeing it twice in one schema is a signal, not a
coincidence: it's this codebase's preferred way to avoid a second table for a
row-shape that's "mostly the same, occasionally different."

---

## Interview defense

**Q: You have `predicted_score` and `assessed_score` on the same row. Isn't
that the same mistake as the `content`/`meta.text` duplication?**
No — the test is whether collapsing the two columns into one loses
information. For `content`/`meta.text`, collapsing to `content` loses
nothing; the read path already does exactly that (`05-text-stored-twice.md`).
For `predicted_score`/`assessed_score`, collapsing to either one loses either
the user's forecast or the engine's outcome — the entire reason the row
exists is to compare the two. They're two distinct, correctly-normalized
facts about the same decision, not two copies of one fact.

```
  Q: duplication or two facts?
  test: collapse to one column — what do you lose?
  content/meta.text  → nothing lost           → duplication (05)
  predicted/assessed → the forecast OR the outcome → two facts (here)
```

**Q: Why isn't the gap (predicted − assessed) its own column?**
It's a derived value with no query that needs it indexed — nobody filters
"decisions where the gap exceeds N" yet. Computing it at display time
(`research-flow.ts:56-63`, `c.scoreGap`) keeps it from becoming a third copy
that could drift from the two source columns. If a query pattern shows up
that needs it (say, ranking decisions by how wrong the gut call was), I'd add
it as a generated column derived from `predicted_score - assessed_score` so
the database keeps it in sync, rather than a plain column another writer
could desync.

---

## See also

- `05-text-stored-twice.md` — the sibling call this pattern is deliberately
  *not*: same-shaped columns, but a real duplication with a declared winner
- `01-vector-column-and-ann-index.md`, `06-trajectory-tables.md` — the same
  `kind`-discriminated-nullable-family move on `chunks`
- `08-lazy-status-transition.md` — what happens to this row after it's
  written: the `review_at` field this file names as "structured because the
  DB compares it" is exactly what that file's `listDue` query drives on
- `audit.md` §1, §2 — model shape and normalization lenses, updated for
  `agents.decisions`
