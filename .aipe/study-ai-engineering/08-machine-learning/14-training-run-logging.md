# Training-run logging — the per-run reproducibility record

*Training-run logging / experiment tracking (MLflow / Weights & Biases shape). Industry standard. buffr has nothing to train — but `src/supabase-trace-sink.ts` IS per-run logging, the same discipline applied to LLM runs instead of training runs.*

## Zoom out, then zoom in

A model you can't reproduce is a model you can't trust. Experiment trackers exist for one reason: every training run appends a row that pins *exactly* what produced this result — the data, the code, the hyperparameters, the score — so six weeks later you can answer "why was run #47 better than #52." buffr trains nothing, so it has no training runs. But it has *conversation* runs, and it logs every one of them with the same discipline.

```
  Zoom out — where the per-run log sits in buffr

  ┌─ Agent run (one conversation) ──────────────────────────────┐
  │  agent.answer() emits CapabilityEvents as it works          │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  emit(event)  (6 event types)
  ┌─ Trace sink layer ────────────▼──────────────────────────────┐
  │  ★ SupabaseTraceSink — the PER-RUN LOG ★                     │ ← we are here
  │  switch over event type → persistMessage() → append row     │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  insert
  ┌─ Storage layer ───────────────▼──────────────────────────────┐
  │  agents.messages  — the run trajectory, replayable in order  │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: a **training-run log** is the append-only record of one run — what went in, what code ran, what came out. The contract it enforces is *reproducibility*: if the log is complete, you can rebuild the result. buffr's `SupabaseTraceSink` is the same shape pointed at LLM runs — it appends a complete, replayable trajectory of every conversation to `agents.messages`. It logs the model version, the cost, the per-step durations, the warnings and errors, in deterministic replay order. What it's *missing* versus a training-run log is the training-specific fields: no score row, no data-version pin, no run-level summary. Same discipline, different fields.

## Structure pass

**Layers:** the run (a conversation) → the events it emits → the appended rows → the table you diff later.

**Axis — "what does each field let you reproduce?"** Trace one question — "if this field were missing, what could I no longer rebuild?" — across the record.

```
  trace "what does this field reproduce?" across a run record

  ┌─ MODEL version ──────┐  which weights ran        buffr: ✓ (model_usage event)
  ├─ HYPERPARAMETERS ────┤  temp / top-p / seed      buffr: ✗ (not captured)
  ├─ DATA version ───────┤  which corpus snapshot     buffr: ✗ (no hash/pin)
  ├─ CODE version (git) ─┤  which commit ran          buffr: ✗ (no commit pin)
  ├─ METRICS / score ────┤  val/test result           buffr: ✗ (no score row)
  ├─ COST ───────────────┤  tokens / time             buffr: ✓ (tokens_used, durationMs)
  └─ TRAJECTORY ─────────┘  the step-by-step path      buffr: ✓ (full, ordered)

  buffr logs the run faithfully — minus the training-specific fields
```

**The seam:** `agents.messages` is *message-level*, a training-run log is *run-level*. The grain flips across that boundary. buffr appends one row per event (step, tool call, model-usage); an experiment tracker appends one row per *run* with the summary baked in. To turn buffr's log into an experiment-tracker row you roll the messages up by `conversation_id` and attach the missing pins — that rollup is the seam, and it's exactly what exercise LOG-1 builds.

## How it works

### Move 1 — the mental model

You already keep a git log: every commit is an append-only record pinning a code state you can check out and rebuild. A training-run log is git for *experiments* — every run is a commit pinning data + code + hyperparameters + result, so you can "check out" any past run and explain it. buffr's trace sink is the same append-only ledger, one entry per event in a conversation.

```
  the kernel — append one immutable record per run

  run completes ─► capture: {data_ver, code_commit, model, hparams, metrics}
                ─► append ONE row (never mutate)
                ─► row is now a permanent, comparable point in history

  later:  diff(run_A, run_B) → "what changed → why did the score move?"

  buffr's version: append one row PER EVENT, keyed by conversation_id
                   (model + cost + trajectory captured; data/code/score not yet)
```

The invariant: rows are immutable and complete. Mutate a row or drop a field and the run stops being reproducible — that's the one failure the whole discipline exists to prevent.

### Move 2 — the step-by-step walkthrough

**What a training-run log captures, field by field.** A real experiment tracker row is a reproducibility contract. Each field answers "what would I be unable to rebuild without it."

```
  the run record — the row you append every run

  ┌──────────────────────────────────────────────────────────┐
  │ run_id        : 47                                        │
  │ git_commit    : a1b2c3d        ← which CODE ran           │
  │ data_version  : corpus@v3 (sha) ← which DATASET snapshot   │
  │ feature_ver   : featpipe@v2     ← which FEATURE pipeline   │
  │ model         : resnet50        ← architecture            │
  │ hyperparams   : {lr:1e-3, seed:42, epochs:20}             │
  │ metrics       : {val_acc:0.91, test_acc:0.89}            │
  │ confusion_mtx : [[..],[..]]     ← per-class results       │
  │ environment   : cuda 12.1, torch 2.3                     │
  └──────────────────────────────────────────────────────────┘
  drop git_commit → can't rebuild the code → run is unreproducible
```

**How buffr's trace sink logs a run — the genuine parallel.** `SupabaseTraceSink.emit()` (`src/supabase-trace-sink.ts:53-85`) is a switch over six `CapabilityEvent` types; each case appends a row to `agents.messages`. This is the same append-per-event discipline.

```
  src/supabase-trace-sink.ts — emit() switch → persistMessage()        // L53-85

  case 'step'           → role=step,       content              // the reasoning move
  case 'tool_call_start'→ role=tool_call,  toolName + args      // the cause
  case 'tool_call_end'  → role=tool,       result+error+durationMs  // ← COST: per-step latency
  case 'model_usage'    → role=model_usage,
                            model = `${provider}/${model}`       // ← MODEL VERSION
                            tokensUsed = inputTokens+outputTokens // ← COST: tokens
  case 'warning'|'error'→ role=type,       message              // the failures
```

Lined up against the run-record fields, the overlap is real:

```
  training-run log field        buffr's trace sink

  MODEL version            ◄──  model_usage → `${provider}/${model}`   ✓
  COST metric              ◄──  tokens_used = input+output             ✓
  per-step DURATION        ◄──  tool_results.durationMs                ✓
  warnings / errors        ◄──  warning / error rows                  ✓
  deterministic ORDER      ◄──  event.timestamp → created_at          ✓
  ───────────────────────       ───────────────────────────────────
  METRIC / score row       ◄──  (none — no eval score persisted)      ✗
  DATA version / commit    ◄──  (none — no corpus hash, no git sha)    ✗
  run-level SUMMARY        ◄──  (message-level only, not rolled up)    ✗
```

**Deterministic replay order — the load-bearing part people skip.** The reason this is a *log* and not just scattered inserts is `event.timestamp → created_at` (`src/supabase-trace-sink.ts:55,82` and `persistMessage` L26,30). `emit()` is synchronous but the writes are queued in `pending[]` and awaited later in `flush()` — so the inserts race. Stamping `created_at` from the *event* time, not insert time, means replay order matches emit order regardless of which insert lands first. Drop that and the trajectory shuffles: you'd have the events but not the *sequence*, and a run you can't replay in order is a run you can't reproduce.

```
  why created_at = event.timestamp (not now())

  emit order:   step₁ → tool_start₂ → tool_end₃ → model_usage₄
  flush():      Promise.all([...])  → inserts RACE, land out of order
  if created_at = now():   rows shuffle → trajectory corrupted
  if created_at = event.ts: order PRESERVED → replayable  ← the contract
```

### Move 2.5 — current state vs future state

```
  Phase A (today)                        Phase B (experiment-tracker shape)
  ─────────────                          ──────────────────────────────────
  message-level rows in agents.messages  + run-level summary row per conversation_id
  model + cost + duration + order        + git_commit pin
  full replayable trajectory             + eval score for the run
  no score / no commit / no rollup       + "diff two runs" view (LOG-1, LOG-2)
```

What *doesn't* change: the per-event capture, the deterministic ordering, the six event types. You're adding a rollup table and two pins on top of a log that already has the hard part right.

### Move 3 — the principle

A run you can't reproduce is a run you can't trust, and the log is the reproducibility contract — that holds whether the run trains weights or answers a question. The discipline ("append an immutable, complete, ordered record of every run") transfers cleanly from training to LLM serving; only the *fields* differ. buffr already practices the discipline rigorously — it just hasn't added the training-specific fields (score, data/code version, run-level rollup) that would make it a full experiment tracker.

## Primary diagram

```
  buffr's trace sink as a per-run log — full picture

  ┌─ Agent run ──────────────────────────────────────────────────┐
  │  agent.answer()  →  emits 6 CapabilityEvent types            │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  emit(event)  (sync)
  ┌─ SupabaseTraceSink (src/supabase-trace-sink.ts) ─────────────┐
  │  switch(event.type):                                         │
  │    step/tool_call_start/tool_call_end/model_usage/warn/error │
  │  push(persistMessage(...)) → pending[]                       │
  │  flush() → Promise.all(pending)   (inserts race)            │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  insert, created_at = event.timestamp
  ┌─ agents.messages ─────────────▼──────────────────────────────┐
  │  conversation_id · role · content · tool_calls · tool_results│
  │  · model · tokens_used · created_at   (← ordered trajectory) │
  │  HAS: model, cost, duration, order   MISSING: score, commit, │
  │       data-version, run-level summary                        │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

This is buffr's most genuine connection to classical ML ops, and it's worth being precise about *why* it's genuine rather than a stretch. Experiment trackers (MLflow, W&B) solve a coordination problem: a team runs hundreds of training jobs, and without a structured per-run log nobody can answer "why did this one win." The answer is always the same shape — append an immutable record pinning everything that varied. buffr's `SupabaseTraceSink` independently arrived at that exact shape for LLM runs: immutable rows, one per event, keyed by run (`conversation_id`), with model version, cost, and duration captured, in deterministic replay order. The comment block at `src/supabase-trace-sink.ts:39-48` even narrates the discipline — it was written *because* the sink previously dropped tool args and token usage, i.e. it was an *incomplete* log, which is the cardinal sin of experiment tracking.

The honest gaps are the training-specific fields. There's no metric row because buffr produces no training metric (the IR eval in `src/cli/eval-cmd.ts` lives in a separate offline path, not stamped onto a run). There's no data-version or git-commit pin, so you can't tie a run to the exact corpus and code that produced it. And it's message-level, not run-level — there's no single row summarizing a conversation. Those three gaps are exactly the LOG-1/LOG-2 exercises: roll the messages up by `conversation_id`, pin the commit and an eval score, and you've converted a faithful trace into an experiment-tracker row.

buffr's prior ML experience (a MediaPipe pose-landmarking pipeline) had no run logging at all — on-device inference produces no training runs to track — so this is new ground, not a refinement of something already done.

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Add a run-level summary row to turn the trace into an experiment-tracker entry

- **Exercise ID:** LOG-1 (Case B — run-level summary not yet exercised). **The lead logging exercise.**
- **What to build:** a run-level summary keyed on `conversation_id` that pins the git commit, an eval score for the run, and total tokens — rolled up from the message-level rows. One row per conversation, the experiment-tracker grain buffr is missing.
- **Why it earns its place:** it closes the biggest honest gap — message-level → run-level — and adds the two pins (commit + score) that make a run reproducible. The story is "I turned a message log into a reproducible experiment record."
- **Files to touch:** `src/supabase-trace-sink.ts` (emit a summary on `flush()`, or add a `finalizeRun()`); a new `agents.runs` summary table or a summary row convention; capture `git rev-parse HEAD` and total `tokens_used` aggregated over the conversation.
- **Done when:** every finished conversation has one summary row carrying {conversation_id, git_commit, eval_score, total_tokens}.
- **Estimated effort:** 1 day.

### Build a "diff two runs" view over agents.messages

- **Exercise ID:** LOG-2 (Case B — run diffing not yet exercised).
- **What to build:** a view or query that takes two `conversation_id`s and compares them — total tokens, total/per-step latency (from `tool_results.durationMs`), tool-call counts, and outcome (warning/error rows) — the "why was run A better than B" comparison an experiment tracker gives you for free.
- **Why it earns its place:** the whole point of per-run logging is comparison; without a diff the log is just storage. This exercises the payoff field.
- **Files to touch:** new `src/cli/diff-runs-cmd.ts` (or a SQL view) reading `agents.messages` filtered by two `conversation_id`s; aggregate `tokens_used`, `tool_results.durationMs`, and error/warning rows per run.
- **Done when:** `diff-runs <id_a> <id_b>` prints a side-by-side of tokens, latency, tool-calls, and errors for the two runs.
- **Estimated effort:** 4–8 hr.

## Interview defense

**Q: buffr trains nothing — how is its trace sink "experiment tracking"?**
Answer: experiment tracking is a *discipline*, not a training-only tool — append an immutable, complete, ordered record of every run so you can reproduce and compare. `SupabaseTraceSink` does exactly that for conversation runs: one row per event in `agents.messages`, keyed by `conversation_id`, capturing the model version (`model_usage` → `provider/model`), cost (`tokens_used` = input+output), per-step latency (`durationMs`), and warnings/errors, in deterministic replay order. It's the same shape as an MLflow run row, minus the training-specific fields. What it lacks is a score row, a data/commit pin, and a run-level rollup — message-level, not run-level.

```
  MLflow run row  ≡  agents.messages rolled up by conversation_id
  shared: model, cost, order   missing: score, commit, run-level summary
```

**Q: Why does buffr stamp created_at from the event timestamp instead of now()?**
Answer: because the writes race. `emit()` is synchronous but each `persistMessage` is queued in `pending[]` and awaited together in `flush()` via `Promise.all` — so the inserts land in nondeterministic order. If `created_at` were `now()`, the rows would shuffle and the trajectory would be corrupted. Stamping `created_at` from `event.timestamp` (the emit time) preserves replay order regardless of insert race. **The part people forget: a run log isn't just the events — it's the events *in order*; lose the order and you've lost reproducibility even with every field present.**

```
  emit: step→tool→model   flush: Promise.all → inserts race
  created_at = event.ts → order preserved → replayable (the contract)
```

## See also

- `13-quantization.md` — the other serving/ops ML concern buffr touches; pairs with run logging.
- `08-confusion-matrices.md` — the per-class metric a training-run log would store and buffr's log lacks.
- `03-train-val-test.md` — the data-version split a run log pins; buffr pins no data version.
- `../05-evals-and-observability/04-llm-observability.md` — the trace itself, the substrate this logging discipline reads from.
