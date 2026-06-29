# Train / validation / test split — and leakage

*Industry standard (split discipline + data leakage). buffr has no split — there's no model to train. Not yet implemented.*

## Zoom out, then zoom in

The SPLIT stage of the pipeline (`01-supervised-pipeline.md`) owns the one number you're allowed to trust, and it's the stage that fails *silently* — a bad split doesn't throw, it just hands you an inflated score that collapses in production. buffr has no split because it trains nothing, but it has the exact unit a correct split would key on: `conversation_id` in `agents.messages`.

```
  Zoom out — where the split sits, and buffr's natural split unit

  ┌─ Storage (Supabase) ─────────────────────────────────────────┐
  │  agents.messages  ← many rows per conversation_id            │
  │  conversation_id  ← THE unit a correct split keys on         │
  └───────────────────────────────┬───────────────────────────────┘
                                  │ the SPLIT stage WOULD attach here
  ┌─ ML SPLIT — ★ NOT PRESENT ★ ─▼────────────────────────────────┐ ← we are here
  │  TRAIN (fit) │ VAL (tune/select) │ TEST (final honest number) │
  │  rule: split at the unit seen as NEW at inference            │
  │  buffr: no split (no model) — but conversation_id is the key │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: you carve labeled data into three sets. **Train** fits the model. **Validation** tunes and selects it. **Test** is the sealed envelope you open once, for the final honest number. The discipline that makes those numbers mean anything is **no leakage** — and the single rule that prevents most leakage is: **split at the unit the model sees as NEW at inference.** For buffr that unit is the conversation, not the message row. The contrl pose pipeline had the same trap latent in it: frames from one workout split across train and test would have leaked, because consecutive frames are near-identical — same shape, different signal.

## Structure pass

**Layers:** the labeled pool (bottom) → the split → the three sets the model touches at different times (top).

**Axis — "what is this set allowed to influence?"** Trace it across the three sets and they stop being interchangeable.

```
  trace "what may this set influence?"

  ┌─ TRAIN ──────┐  influences: the model's parameters
  │  fit         │  (model learns directly from these rows)
  └──────┬───────┘
  ┌─ VAL ────────┐  influences: your choices (hyperparams, model family,
  │  tune/select │   threshold) — NOT parameters directly
  └──────┬───────┘
  ┌─ TEST ───────┐  influences: NOTHING — you only read it, once
  │  final score │  (touch it twice and it stops being honest)
  └──────────────┘

  three sets, three permission levels — that ordering IS the discipline
```

**The seam that leaks:** the boundary between train and val/test. Leakage is information crossing that seam the wrong way — and the most common form isn't exotic, it's *splitting at the wrong unit*. If two rows from the same conversation land one in train and one in val, the model effectively *memorized that conversation's context* during training and then "predicts" it on val. The axis-answer ("what influenced this set?") gets corrupted: val was supposed to be untouched by training, but a sibling row already taught the model the answer. That's why the seam has to fall *between conversations*, never *within* one.

## How it works

### Move 1 — the mental model

You already know this from holding out a test fixture. You'd never write a test that asserts against data your function was *trained on* — it'd pass trivially and tell you nothing. The test set is the holdout you swear not to peek at while building. The trap unique to ML is *subtle* peeking: not training directly on the test row, but training on a near-duplicate of it (a sibling message from the same conversation) — which leaks the answer just as surely.

```
  PATTERN — three sets, sealed in order, split BY unit not BY row

  labeled pool (group rows by conversation_id FIRST)
        │ assign whole conversations to sets (never split a conversation)
        ▼
  ┌─ TRAIN ───────┐   ┌─ VAL ────────┐   ┌─ TEST (sealed) ─┐
  │ conv 1,2,3,4  │   │ conv 5,6      │   │ conv 7,8        │
  │ FIT here      │   │ TUNE here     │   │ open ONCE       │
  └───────────────┘   └──────────────┘   └─────────────────┘
        ▲ no conversation appears in two sets ▲
```

The strategy: group by the inference unit, *then* split, so no unit straddles the seam.

### Move 2 — the step-by-step walkthrough

Four moves: the three sets' jobs, then the two ways to split, then the leakage failure, then the clean version.

**The three sets and their jobs.** Each set is touched at a different moment and is allowed to influence a different thing. Train is read many times (the model fits to it). Val is read repeatedly *by you* (every time you compare models or tune a knob). Test is read exactly once, at the very end.

```
  The three sets — when touched, what they decide

  set    │ touched          │ decides                │ danger if misused
  ───────┼──────────────────┼────────────────────────┼──────────────────
  TRAIN  │ every fit step   │ model parameters       │ —
  VAL    │ every comparison │ which model / settings │ overfit-to-val
  TEST   │ once, at the end │ the reported number    │ peeking → number lies
```

Boundary condition: if you tune against the test set even once, it silently becomes a second validation set, and you no longer have an honest final number. The fix is discipline, not code — seal it.

**Random split vs temporal split.** How you assign units depends on whether time matters. If rows are exchangeable, random-assign whole units. If the model will predict the *future* from the *past* — and buffr's trajectories have a `created_at`, so time is real — you split *temporally*: train on older conversations, test on newer ones, so the test mimics "deployed and seeing tomorrow's data."

```
  Random vs temporal split (buffr trajectories carry created_at)

  RANDOM (units exchangeable)        TEMPORAL (time matters)
  ──────────────────────────         ───────────────────────
  shuffle conversations              sort by created_at
  ┌───┬───┬───┐                       past ──────────────► future
  │tr │val│tst│  (any order)          ┌─────────┬─────┬─────┐
  └───┴───┴───┘                       │  TRAIN  │ VAL │ TEST│
                                      └─────────┴─────┴─────┘
                                       older               newer
                                       (test = "tomorrow's runs")
```

Temporal split catches drift (`15-drift-detection.md`) a random split hides: if the world changes over time, a random split smears future into train and over-reports.

**The leakage failure — split by row.** This is the mistake, drawn explicitly. buffr's `agents.messages` has *many rows per conversation* (step, tool_call, tool, model_usage...). Split by row and rows from conversation 5 land in both train and val. The model sees conversation 5's early turns in training, then "predicts" its later turns on val — and aces it, because it already saw the session.

```
  LEAKAGE — splitting at the ROW level (the bug)

  agents.messages rows for conversation_id = 5
  ┌──────┬──────┬───────────┬──────┬─────────────┐
  │ step │ step │ tool_call │ tool │ model_usage │
  └──┬───┴──┬───┴─────┬─────┴──┬───┴──────┬──────┘
     │      │         │        │          │
   TRAIN  TRAIN     VAL      TRAIN       VAL      ← row-level split
     └──────┴─────────┼────────┴──────────┘
                      ▼
   model memorized conv 5 in TRAIN, "predicts" conv 5 in VAL
   → val score inflated → prod collapses on truly-new conversations
```

The val number looks great and means nothing — the classic leaky split.

**The clean split — by conversation_id.** Group all rows by `conversation_id` first, assign *whole conversations* to sets, and no session ever straddles the seam. The model is evaluated on conversations it has *never* seen any part of — which is exactly what happens at inference.

```
  CLEAN — splitting at the conversation_id level (the fix)

  group rows BY conversation_id, THEN assign whole groups:
  ┌─ conv 1 (all rows) ─┐ ┌─ conv 5 (all rows) ─┐ ┌─ conv 8 (all rows) ─┐
  │ TRAIN                │ │ VAL                  │ │ TEST                 │
  └─────────────────────┘ └─────────────────────┘ └─────────────────────┘
  pseudocode:
    groups = group(messages, by = conversation_id)   // unit = conversation
    train, val, test = split(groups, 0.7, 0.15, 0.15) // split GROUPS, not rows
    assert no conversation_id in two sets             // the invariant
```

The `assert` is the load-bearing line: a split is only honest if you can prove no unit crosses the seam.

### Move 3 — the principle

A split is a promise that your reported number reflects performance on data the model has genuinely never seen — and the only way to keep that promise is to split at the unit the model treats as new at inference. Get the unit wrong (split rows when the model predicts per conversation) and you leak context: the model "succeeds" by memorizing sessions, and the failure is invisible until production, where every conversation really is new. The deeper rule generalizes past buffr: whenever your data has *groups* (a user's many events, a patient's many visits, a conversation's many messages), split by the group, not the event — same trap, same fix, every time.

## Primary diagram

The full split discipline, leaky vs clean, with buffr's unit marked.

```
  Train/Val/Test — the discipline, the leak, the fix

  labeled pool (agents.messages — MANY rows per conversation_id)
        │
        ├─ WRONG: split by ROW ──────────────────────────────────┐
        │   conv 5 rows scattered across train+val               │
        │   → model memorizes session → val score LIES           │
        │                                                         │
        └─ RIGHT: group by conversation_id, split the GROUPS      │
            ┌─ TRAIN 70% ─┐ ┌─ VAL 15% ─┐ ┌─ TEST 15% ─┐         │
            │ fit params  │ │ tune/select│ │ open ONCE  │         │
            └─────────────┘ └────────────┘ └────────────┘         │
            invariant: no conversation_id in two sets ────────────┘
            (temporal variant: sort by created_at, past→future)

  ★ buffr: no split exists; conversation_id is the unit it WOULD use ★
```

## Elaborate

The train/val/test triad is the foundation of honest ML evaluation, and "grouped" or "blocked" splitting is the standard fix for leakage when data has natural groups (scikit-learn ships `GroupKFold` for exactly this). Leakage is consistently ranked among the most common and most expensive ML mistakes precisely because it's *silent* — the model looks brilliant in development and fails in production, with nothing in the code to flag it. Temporal splitting connects forward to drift (`15-drift-detection.md`): a temporal split is the cheapest drift detector you have, because if performance drops from train-era to test-era data, the distribution moved. For buffr the connection is concrete and a little ironic — the repo already has the right unit baked into its schema (`conversation_id`, plus `created_at` for temporal ordering), so if it ever trained on trajectories, the hardest part of doing the split right is already done by the data model. The contrl pose pipeline carried the latent version of this: per-frame splitting would have leaked because adjacent frames are near-duplicates — the workout was the group, the frame was the event.

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Write a conversation-level splitter over agents.messages

- **Exercise ID:** SPLIT-1 (Case B — train/val/test split not yet implemented). **The core exercise: it makes the SPLIT stage real on buffr's actual schema.**
- **What to build:** a splitter that reads `agents.messages`, groups rows by `conversation_id`, and assigns *whole conversations* to train/val/test (70/15/15) — with a hard assertion that no `conversation_id` appears in two sets. Add a temporal mode that orders by `created_at` (past→future) instead of random.
- **Why it earns its place:** it's the SPLIT stage for PIPE-1, and it forces the leakage discipline on the exact data shape (many rows per conversation) where row-level splitting would silently inflate every number. The "I split by the inference unit and proved no session leaked" story.
- **Files to touch:** read the schema written by `src/supabase-trace-sink.ts` (`agents.messages.conversation_id`, `created_at`); put the splitter next to `src/cli/eval-cmd.ts` for the classifier harness to consume.
- **Done when:** the splitter returns three disjoint sets keyed on `conversation_id`, the no-overlap assertion passes, and a temporal mode orders by `created_at`.
- **Estimated effort:** 4–8hr.

### Extend eval/queries.json into a frozen held-out test set

- **Exercise ID:** SPLIT-2 (Case B — held-out test set not yet implemented).
- **What to build:** grow `eval/queries.json` past 3 rows, then carve it into a *frozen* test slice that `src/cli/eval-cmd.ts` reports on *only* — the test set you swear not to tune against — keeping a separate dev slice for iteration.
- **Why it earns its place:** the IR eval is buffr's only labeled-pair file, and right now there's no separation between "the rows I iterate on" and "the rows I report." This installs the sealed-envelope discipline on real retrieval evaluation.
- **Files to touch:** `eval/queries.json` (split into dev + frozen test); `src/cli/eval-cmd.ts` (report on the frozen slice, iterate on the dev slice).
- **Done when:** `npm run eval` reports the final number on the frozen test slice and never touches it for tuning.
- **Estimated effort:** 2–4hr.

## Interview defense

**Q: How do you split data, and what's the one rule that prevents most leakage?**
Answer: train fits the model, validation tunes and selects it, test is the sealed envelope I open once for the honest number. The one rule that prevents most leakage: split at the unit the model sees as NEW at inference. If my data has groups — a conversation's many messages, a user's many events — I split by the group, not the row. Split by row and sibling rows from the same group land in both train and val, the model memorizes the group, and my val score lies.

```
  group by conversation_id ──► split the GROUPS ──► no session straddles the seam
  (split by row ──► leak ──► inflated val ──► prod collapse)
```

**Q: In buffr specifically, what would you split on and why?**
Answer: `conversation_id` in `agents.messages`. Each conversation has many rows — step, tool_call, tool, model_usage — so splitting by row would scatter one conversation across train and val, leaking within-conversation context. At inference, every conversation is genuinely new, so the test must mirror that: whole conversations, never shared across sets. And since rows carry `created_at`, I'd prefer a temporal split — train on older conversations, test on newer — so the eval also catches drift. **The part people forget: leakage is silent. Nothing throws; you just get a beautiful val number and a production faceplant.**

```
  conversation_id = the inference unit · created_at = temporal order
  split WHOLE conversations · assert none in two sets
```

## See also

- `01-supervised-pipeline.md` — the SPLIT stage this file opens up.
- `02-feature-engineering.md` — why scalers/encoders must be fit on train only (a leakage form).
- `04-model-selection.md` — model selection happens on the VAL set, never the test set.
- `15-drift-detection.md` — a temporal split is the cheapest drift detector.
- `../05-evals-and-observability/01-eval-set-types.md` — golden/adversarial/regression sets and the frozen-test discipline (SPLIT-2).
