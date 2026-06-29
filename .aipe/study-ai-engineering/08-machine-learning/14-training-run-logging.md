# Training Run Logging

### *industry: experiment tracking / training-run logging · type: the audit trail that makes a trained model reproducible instead of a lucky accident*

## Zoom out

You already have a logging instinct in buffr — `SupabaseTraceSink` captures every inference run (the inputs, the tool calls, the model, the token counts) into `agents.messages`. That's run logging, but for *inference*. Training-run logging is the same discipline pointed at the *other* end of the lifecycle: when you train a model, you log what produced it, so that six weeks later you can answer "which data, which hyperparams, which commit made this artifact?" without guessing. Without it, every good result is a coin flip you can't re-flip.

**The MLOps lifecycle, with the moment training-run logging fires marked**
```
┌────────┐ ┌──────────┐ ┌───────┐ ┌───────┐ ┌────────┐ ┌─────────┐
│  Data  │►│ Features │►│ Split │►│ ★TRAIN│►│ Deploy │►│ Monitor │
│        │ │          │ │       │ │ ★     │ │        │ │         │
└────────┘ └──────────┘ └───────┘ └───┬───┘ └────────┘ └─────────┘
                                      │   ◄── this file
                       Every TRAIN run emits a RECORD: data version,
                       hyperparams, seed, metrics, the artifact, the
                       git commit — so the run can be REPRODUCED
```
Training-run logging wraps the train stage: the model isn't the only output, the *record of how it was made* is an output too.

## Structure pass

One axis organizes everything you log: **does this input determine the model, or does the model determine this output?** Inputs (data version, hyperparams, seed, code commit) are what you must pin to reproduce. Outputs (metrics, confusion matrix, the artifact) are what you compare runs by. A run record is just inputs-plus-outputs, stamped and immutable.

**The one axis: inputs you pin vs outputs you compare**
```
   INPUTS (pin these → reproducibility)      OUTPUTS (record these → comparison)
   ┌──────────────────────────┐             ┌──────────────────────────┐
   │ • data version / hash     │             │ • metrics (P@1, R@3, ...)│
   │ • feature set             │   ──train──►│ • confusion matrix        │
   │ • hyperparameters         │             │ • model artifact (file)   │
   │ • random seed             │             │ • training curves         │
   │ • git commit of the code  │             │ • timing / cost           │
   └──────────────────────────┘             └──────────────────────────┘
                  │                                       │
   ┌──────────────┴───────────── THE SEAM ────────────────┴─────────────┐
   │ Same INPUTS must yield the same OUTPUTS. If they don't, something    │
   │ unpinned leaked in (an unlogged seed, a moving dataset). That gap    │
   │ IS the bug reproducibility hunts.                                    │
   └─────────────────────────────────────────────────────────────────────┘
```
The seam: reproducibility is the claim that inputs fully determine outputs. Anything you forgot to log is a hidden input — and hidden inputs are why "I can't reproduce my own best run" happens.

## How it works

### Move 1 — Mental model

The mental model: **a training run is a pure function, and the run record is its call site.** `model, metrics = train(data, features, hyperparams, seed, code)`. If you logged every argument and every return value, you can replay the call. If any argument was implicit (a global seed, today's dataset, uncommitted code), the function isn't pure and the result isn't reproducible.

**The pattern: train() as a logged pure function**
```
            ┌─────────────────────────────────────────┐
   inputs ──►        train(data, hp, seed, code)        ──► model + metrics
            └─────────────────────────────────────────┘
                              │
                     RUN RECORD = { all inputs } + { all outputs } + timestamp
                              │
              replay the record's inputs ──► should reproduce the outputs
```
The record is the receipt that lets you re-run the function and get the same answer.

### Move 2 — Walk the mechanism

**Part 1 — Pin the inputs at run start.** Before a single gradient step, snapshot what could move: the data version, the hyperparams, the seed, and the exact code commit. Illustrative pseudocode, not buffr code:

**Capture inputs before training (illustrative)**
```python
# ILLUSTRATIVE ONLY — not buffr code. Snapshot every input first.
run = start_run()
run.log_params({
    "data_version": sha256_of(dataset),     # pins WHICH data
    "feature_set":  "embed768+len+lang",    # pins HOW it was featurized
    "lr": 3e-4, "epochs": 10, "batch": 32,  # hyperparameters
    "seed": 42,                              # pins randomness
    "git_commit": current_commit(),          # pins the CODE
})
set_global_seed(42)                          # actually USE the seed
```

**Part 2 — Stream metrics as the run progresses.** Log per-epoch so you can see the training curve, not just the final number. A loss that diverged at epoch 7 is invisible if you only logged the end.

**Metrics over time, not just the final value**
```
   loss
    │ ●
    │  ●●
    │    ●●●            ◄── logging EVERY epoch shows the shape;
    │       ●●●●●●          logging only the end hides the divergence
    └────────────────► epoch
        each point = run.log_metric("loss", v, step=epoch)
```

**Part 3 — Log the evaluation outputs, including the confusion matrix.** The final metrics (your P@1/R@3 family) and the confusion matrix are first-class outputs of the run — they're how you'll compare this run to the next.

**Eval outputs attach to the run record**
```
   trained model ──eval on held-out set──► P@1, R@3, F1
                                       └─► confusion matrix (the 4-cell / KxK table)
                                              │
                          run.log_metrics({...}); run.log_artifact("confusion.png")
```

**Part 4 — Store the artifact and stamp it with its run id.** The model file is logged *as part of the run*, so the artifact and the conditions that produced it travel together. A model file with no run id attached is an orphan you can't trust.

**Artifact + run id travel together**
```
   model.pkl  ──┐
                ├─► run_id: 2026-06-29-a17f  ◄── now the artifact KNOWS its lineage
   run record ──┘     data_version, hp, seed, commit all reachable from the id
```

### Move 2.5 — Current vs future

buffr already logs *inference* runs. It logs no *training* runs, because it trains nothing. The discipline transfers; the target changes.

**SupabaseTraceSink (inference) vs the ml/ run logger (training) — same shape, other end**
```
   TODAY — INFERENCE capture (real):
     loop emits events ──► SupabaseTraceSink ──► agents.messages
       { role, content, tool_calls, tool_results, model, tokens_used, created_at }
       ★ this IS run logging — inputs, outputs, model, cost — but per QUERY

   FUTURE — TRAINING capture (the exercise):
     train() ──► run logger ──► agents.training_runs (new) or MLflow
       { data_version, hyperparams, seed, git_commit, metrics, artifact_path }
       ★ same instinct, pointed at the train stage in ml/
```

### Move 3 — The principle

The principle: **a model you can't reproduce is a model you can't trust, debug, or improve.** The run record is the unit of accountability — it turns "my best result" from an anecdote into a re-runnable fact. The cost is discipline (log before you train, not after), and the payoff is that every run becomes comparable and every artifact becomes traceable to the exact conditions that made it.

## Primary diagram

**The full picture: a training run as a logged, reproducible, comparable unit**
```
   ┌──────────────────────── RUN START ────────────────────────┐
   │ PIN INPUTS:  data_version · feature_set · hyperparams ·     │
   │              seed · git_commit                              │
   └──────────────────────────────┬─────────────────────────────┘
                                   ▼
                          ┌─────────────────┐
                          │   train()       │  ◄── stream loss/metrics per epoch
                          └────────┬────────┘
                                   ▼
   ┌──────────────────────── RUN OUTPUTS ───────────────────────┐
   │ metrics (P@1/R@3/F1) · confusion matrix · model artifact     │
   └──────────────────────────────┬─────────────────────────────┘
                                   ▼
                    RUN RECORD  { inputs + outputs + run_id }
                      │                         │
        replay inputs ─► reproduce outputs      compare run_id A vs B
        (REPRODUCIBILITY)                       (EXPERIMENT TRACKING)
                                   │
              analogous to SupabaseTraceSink ►► agents.messages,
              which already does this for INFERENCE runs in buffr
```
Read it as a loop receipt: pin the inputs, train, capture the outputs, stamp them with a run id — now the run can be both reproduced and compared, exactly the discipline `SupabaseTraceSink` already applies to inference.

## Elaborate

- **Tools formalize this, they don't invent it.** MLflow and Weights & Biases are just structured run loggers: `log_param`, `log_metric`, `log_artifact`, a run id, a comparison UI. You can reach for one, or — given buffr already has Postgres and a sink pattern — log training runs to an `agents.training_runs` table and stay in your own stack.
- **The seed is the most-forgotten input.** Without pinning *and using* the random seed, two runs with identical hyperparams diverge, and your "reproducible" claim is false. Logging the seed value while letting the global RNG run unseeded is a classic silent failure.
- **`agents.messages` already proves you get the instinct.** The `SupabaseTraceSink` test asserts it captures `tool_calls` (the cause), `tool_results` with `durationMs`/`error`, `model`, and `tokens_used` — not just role+content. That is precisely the "log the full signal, not just the headline" discipline training-run logging demands. You've built it once, for inference.
- **Data version is a hash, not a date.** "Trained on the June data" is not a version. A content hash (or a dataset snapshot id) is, because the June data can change under you. Reproducibility needs an immutable handle on the exact bytes.
- **The confusion matrix is a logged artifact, not a console print.** If it scrolls past in a terminal, it's gone. Attached to the run, it's comparable across runs — you can watch a specific class's recall recover (or rot) run over run.

## Project exercises

### Exercise — A training-run logger in ml/, mirroring SupabaseTraceSink

- **Exercise ID:** [B2C.14] Phase 2C
- **What to build:** *Not yet implemented — buffr trains nothing.* Build the logger first, even before a serious model: a `MLRunSink` in `ml/` that, around a tiny `train()` call, pins inputs (data hash, hyperparams, seed, git commit) and records outputs (metrics, confusion matrix path, artifact path) to a new `agents.training_runs` table — deliberately echoing how `SupabaseTraceSink` writes inference runs to `agents.messages`.
- **Why it earns its place:** It transfers a discipline you already own (inference capture) to a context you don't (training capture), and produces the reproducibility receipt. The signal is that you logged the run *before* you cared about the result — that's the habit of someone who's been burned by an unreproducible best run.
- **Files to touch:** new `ml/run_sink.py` (or `.ts` to match the stack), new `ml/train.py` (the tiny model it wraps), new `sql/002_training_runs.sql` (the table, modeled on `agents.messages`), referencing the pattern in `src/supabase-trace-sink.ts`.
- **Done when:** two runs with the same pinned inputs produce the same metrics, and you can query `agents.training_runs` to diff run A vs run B by hyperparams.
- **Estimated effort:** Medium — a day to a day and a half. The table + sink is the bulk; the model is intentionally trivial.

### Exercise — Prove reproducibility by replaying a run

- **Exercise ID:** [B2C.14b] Phase 2C
- **What to build:** *Not yet implemented — buffr trains nothing.* Add a `ml/replay.py` that reads a `run_id` from `agents.training_runs`, checks out the logged git commit (or asserts the current one matches), re-applies the logged seed + hyperparams + data hash, retrains, and asserts the new metrics match the recorded ones within tolerance.
- **Why it earns its place:** Logging is a claim; replay is the proof. Most candidates log params and never verify the loop closes. A passing replay is the difference between "I track experiments" and "my experiments are reproducible."
- **Files to touch:** new `ml/replay.py`, reads `agents.training_runs`, reuses `ml/train.py`.
- **Done when:** `replay.py <run_id>` exits green when inputs match and red (with the offending unpinned input named) when you perturb one.
- **Estimated effort:** Medium — half a day on top of the logger.

## Interview defense

**Q: "What do you log per training run, and why each?"**
```
   INPUTS  → data_version, features, hyperparams, seed, git_commit  (replay)
   OUTPUTS → metrics, confusion matrix, model artifact              (compare)
   ┌────────────────────────────────────────────────────────┐
   │ inputs pin reproducibility · outputs enable comparison  │
   └────────────────────────────────────────────────────────┘
```
Anchor: "Inputs so I can replay it, outputs so I can compare it — a run record is both."

**Q: "How is this different from app logging you've already built?"**
```
   SupabaseTraceSink ──► agents.messages   (INFERENCE: per-query inputs/outputs)
   ml/ run logger    ──► training_runs      (TRAINING: per-run inputs/outputs)
        same discipline, opposite end of the lifecycle
```
Anchor: "I've built run capture for inference in buffr — `SupabaseTraceSink` into `agents.messages`. Training-run logging is the same instinct aimed at the train stage."

**Q: "Have you ever logged a run you could actually reproduce?"**
```
   logging params ◄── most candidates
   replaying the run + asserting the metrics match ◄── the signal
```
Anchor: "Most candidates have only consumed pre-trained models and never owned a training run. Having logged one *and proven it replays* is the signal — that's the [B2C.14] / [B2C.14b] pair."

## See also

- ./13-quantization.md — the quantized artifact and its post-quant eval are outputs you log in the run record.
- ./08-confusion-matrices.md — the confusion matrix is a first-class logged output.
- ./03-train-val-test.md — the split is a pinned input; logging the split makes the metric meaningful.
- ./15-drift-detection.md — drift compares *production* distribution to the *training* distribution your run record pinned.
- ../03-retrieval-and-rag/09-stale-embeddings.md — the embedding-version analog of "data version."
- ../05-evals-and-observability/04-llm-observability.md — the inference-side capture (`SupabaseTraceSink`) this discipline mirrors.
- ../06-production-serving — where a logged artifact gets promoted to serving.
- ../09-ml-system-design-templates — experiment tracking as a required box in any training-system design.
