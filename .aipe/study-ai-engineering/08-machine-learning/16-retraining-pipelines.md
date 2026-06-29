# Retraining Pipelines

### *industry: retraining pipelines / continuous training (CT) · type: the automated loop that decides when to rebuild a model and whether the rebuild is allowed to ship*

## Zoom out

The previous files gave you the parts: a labeled set to score against, run logging to make rebuilds reproducible, drift detection to notice the world moved. A retraining pipeline is what *wires them into a loop*. It's the answer to "a model decays — now what?" automated: something decides to retrain, the model is rebuilt, the new model is tested against the old one, and only a winner ships. buffr can't run this end-to-end yet because it has no model to rebuild — but it already owns the hardest, most-skipped piece: `eval/queries.json`, the gate that decides whether a challenger is actually better than the champion.

**The MLOps lifecycle, drawn as the LOOP this file closes**
```
┌────────┐ ┌──────────┐ ┌───────┐ ┌───────┐ ┌────────┐ ┌─────────┐
│  Data  │►│ Features │►│ Split │►│ Train │►│ Deploy │►│ Monitor │
└───▲────┘ └──────────┘ └───────┘ └───────┘ └────────┘ └────┬────┘
    │                                                        │
    └──────────────── ★ RETRAINING PIPELINE ★ ◄──────────────┘
         trigger fires ──► rebuild ──► validate-vs-incumbent ──► ship/rollback
                              this file: the arrow that closes the loop
```
Retraining is the lifecycle eating its own tail: the monitor's signal flows back to data and kicks off a fresh run, gated so a worse model can't reach production.

## Structure pass

One axis organizes the whole pipeline: **what fired the rebuild, and did the rebuild earn the right to ship?** The first half is the *trigger* (three kinds). The second half is the *gate* (champion vs challenger). Everything else is plumbing between them.

**The one axis: trigger (why rebuild) → gate (may it ship)**
```
   TRIGGERS (any one fires) ──────────►  REBUILD  ──────────► GATE
   ┌──────────────────────┐                                  ┌──────────────────┐
   │ scheduled (cron)      │            train fresh          │ challenger vs     │
   │ drift-triggered (PSI) │            challenger model     │ champion on the   │
   │ perf-triggered (eval) │                                 │ labeled set       │
   └──────────────────────┘                                  └────────┬─────────┘
                                                          better? ─────┤
                                              ┌───────────────────┬────┘
                                              ▼ ship (promote)    ▼ rollback (keep champion)

   ┌────────────────────────────── THE SEAM ──────────────────────────────┐
   │ A trigger is NOT permission to ship. The GATE is the safety: a fresh   │
   │ model that scores WORSE than the incumbent must be rejected, not       │
   │ deployed just because it's newer.                                      │
   └────────────────────────────────────────────────────────────────────────┘
```
The seam: newer is not better. The gate exists precisely because a retrain can produce a regression, and "we just retrained" must never override "the old model scored higher."

## How it works

### Move 1 — Mental model

The mental model: **champion/challenger.** The model in production is the *champion*. A retrain produces a *challenger*. The challenger only becomes champion if it beats the incumbent on the same labeled evaluation — otherwise it's discarded and the champion stays. This is the whole safety story in two words.

**The pattern: challenger must beat champion on the same gate to be promoted**
```
        CHAMPION (in prod)                CHALLENGER (just retrained)
              │                                   │
              └──────────► SAME eval set ◄────────┘
                                │
                    challenger_score > champion_score ?
                       ┌──────────────┬──────────────┐
                       │ YES → promote │ NO → reject   │
                       │ (new champion)│ (rollback)    │
                       └──────────────┴──────────────┘
```
The incumbent is the bar; the challenger must clear it on identical, fair ground before it ships.

### Move 2 — Walk the mechanism

**Part 1 — A trigger fires.** Three independent triggers, any of which starts a run. Scheduled is dumb-but-reliable; drift- and performance-triggered are reactive.

**The three triggers, by what they watch**
```
   SCHEDULED      ─ cron: "every Sunday" ───────────► fires on TIME
   DRIFT          ─ PSI > 0.25 (file 15) ───────────► fires on INPUT shift
   PERFORMANCE    ─ metric drop on labeled canary ──► fires on OUTPUT quality drop
        │
   any one ──► enqueue a retrain run
```

**Part 2 — Rebuild reproducibly.** The retrain is a logged run (file 14): pinned data version, hyperparams, seed, commit. The challenger artifact is stamped with its run id so its lineage is traceable.

**The challenger is a logged run, not a one-off**
```
   trigger ──► train() with PINNED inputs ──► challenger artifact + run_id
                         │
            reproducible by construction (file 14 discipline)
```

**Part 3 — Validate against the incumbent on the labeled set.** Both models score on the *same* held-out labeled data. In buffr's shape, that's exactly what `eval/queries.json` is: `{query, relevant[]}` rows yielding P@1/R@3. Illustrative pseudocode, not buffr code:

**Gate: same labeled set, champion vs challenger (illustrative)**
```python
# ILLUSTRATIVE ONLY — not buffr code. The validate-vs-incumbent gate.
labeled = load("eval/queries.json")              # {query, relevant[]} rows
champ_score = evaluate(champion,   labeled)      # P@1 / R@3 today
chal_score  = evaluate(challenger, labeled)      # same metric, same data

if chal_score > champ_score + MARGIN:            # MARGIN guards against noise
    promote(challenger)                          # new champion → deploy
else:
    rollback(challenger)                         # keep champion, log the reject
```

**Part 4 — Promote or roll back, and log the decision either way.** A win promotes the challenger to champion and deploys it. A loss keeps the incumbent and records *why* the challenger lost — a rejected retrain is signal, not noise.

**The terminal fork: ship or keep, always logged**
```
   challenger WINS ──► promote ──► deploy ──► challenger is new champion
   challenger LOSES ─► rollback ─► champion stays ──► log the reject + scores
                                          │
                       either way: the decision is RECORDED (run id + verdict)
```

### Move 2.5 — Current vs future

buffr has the gate but not the model. The eval harness is real today; the loop around it is the ceiling.

**What buffr has vs the full loop**
```
   HAVE TODAY (real):
     eval/queries.json + P@1/R@3 ──► the validate-vs-incumbent GATE exists
     drift monitor (file 15) ──► the drift TRIGGER is buildable
     run logging (file 14) ──► reproducible REBUILD is buildable

   MISSING (the ceiling):
     a TRAINED MODEL to rebuild ──► without it, there's no champion/challenger
     ★ the full retraining loop is gated on training a model at all
```

### Move 3 — The principle

The principle: **automate the rebuild, but never automate away the gate.** A retraining pipeline's value is that it reacts to decay without a human babysitting it — *and* that it refuses to ship a regression. The trigger makes you fast; the champion/challenger gate makes you safe. Remove the gate and you've built a machine that confidently deploys worse models on schedule.

## Primary diagram

**The full picture: three triggers into a rebuild, a labeled gate, and a ship-or-rollback fork**
```
   ┌───────────── TRIGGERS ─────────────┐
   │ scheduled (cron)                    │
   │ drift (PSI > 0.25, file 15)         │──┐
   │ performance (eval drop on canary)   │  │
   └─────────────────────────────────────┘  ▼
                                    REBUILD (logged run, file 14)
                                    pinned data/hp/seed/commit ──► challenger + run_id
                                             │
                              ┌──────────────▼──────────────┐
                              │  GATE: champion vs challenger │
                              │  SAME labeled set             │
                              │  ★ eval/queries.json → P@1/R@3│ ◄── buffr HAS this
                              └──────────────┬──────────────┘
                            challenger > champion + MARGIN ?
                              ┌──────────────┴──────────────┐
                              ▼ YES                          ▼ NO
                         PROMOTE → deploy               ROLLBACK → keep champion
                         (new champion)                 (log the reject + scores)
```
Read it top to bottom: any trigger starts a reproducible rebuild, the challenger faces the champion on buffr's existing labeled gate, and only a clear winner ships — the gate is the one piece buffr already owns.

## Elaborate

- **`eval/queries.json` is the load-bearing asset.** A retraining pipeline is only as trustworthy as its gate, and the gate is a *labeled* evaluation. buffr already has one: `[{query, relevant[]}]` yielding P@1/R@3. That's the hard part most teams skip — they automate the retrain and ship on "loss went down in training," which says nothing about real quality. You have the right artifact; you're missing the model in front of it.
- **MARGIN matters — don't promote on noise.** Eval scores wobble. Promoting whenever `chal > champ` by any amount means you'll churn champions on statistical noise. Require a meaningful margin (or a significance test) so you only promote real improvements.
- **The performance trigger needs *fresh labels*.** Drift (file 15) needs no labels — it watches inputs. But the performance trigger watches *quality*, which means a labeled canary: a small, continuously-labeled slice of production. Without fresh labels you cannot detect quality decay, only input decay.
- **Shadow / canary deploys de-risk promotion.** Even a gate-passing challenger can surprise you in prod. Running it in shadow (scoring live traffic without serving it) or canary (a small % of traffic) catches gate-blind-spots before full rollout. This is the serving-side cousin of the offline gate.
- **A scheduled trigger is a floor, not a strategy.** Cron retraining guarantees freshness but wastes compute when nothing changed and lags when things change fast. The mature setup is scheduled *plus* reactive (drift/performance) — the cron is the safety net under the reactive triggers.

## Project exercises

### Exercise — A retraining loop gated on eval/queries.json

- **Exercise ID:** [B3.16] Phase 5
- **What to build:** *Not yet implemented — buffr trains nothing,* so this is the Phase 5 ceiling and is explicitly gated on first having a trained model (the [B2C.13]/[B2C.14] exercises). Once a small `ml/` model exists, build `ml/retrain.py`: a loop that retrains a challenger (reproducible run), scores both champion and challenger on `eval/queries.json`, and promotes only if the challenger beats the champion by a margin — otherwise rolls back and logs the reject.
- **Why it earns its place:** It's the capstone that wires together the labeled set, run logging, and the champion/challenger gate into the loop real MLOps teams run. The signal is that you built the *gate*, not just the retrain — proving you understand newer ≠ better.
- **Files to touch:** new `ml/retrain.py`, reads `eval/queries.json`, reuses `ml/train.py` + the run logger from [B2C.14], writes a promotion/rollback verdict to `agents.training_runs`.
- **Done when:** feeding a deliberately-worse challenger triggers a logged rollback (champion stays); a genuinely-better one promotes and deploys.
- **Estimated effort:** Large — two to three days, and only after a trained model exists. The loop is moderate; the gate's correctness (margin, fairness of comparison) is the real work.

### Exercise — Drift- and performance-triggered retraining

- **Exercise ID:** [B3.16b] Phase 5
- **What to build:** *Not yet implemented — buffr trains nothing.* Extend [B3.16] with the two reactive triggers: subscribe `ml/retrain.py` to the `agents.drift_events` rows from [B2C.15b] (drift trigger) and to a periodic P@1/R@3 check on a labeled canary (performance trigger), so a PSI breach or a metric drop — not just cron — can start a retrain.
- **Why it earns its place:** Scheduled-only retraining is the beginner version. Reactive triggers — rebuild *because* drift or quality moved — is the staff-level loop, and it consumes the drift monitor you already built in file 15.
- **Files to touch:** `ml/retrain.py`, reads `agents.drift_events` (from [B2C.15b]) and runs the `eval/queries.json` canary check; optional `ml/triggers.py`.
- **Done when:** injecting drift writes a `drift_events` row that kicks off a retrain run, and a simulated eval drop on the canary does the same — both logged with the trigger reason.
- **Estimated effort:** Medium to large — two days on top of [B3.16].

## Interview defense

**Q: "When do you retrain a model?"**
```
   ┌──────────────────────────────────────────────┐
   │ scheduled (cron)        — freshness floor      │
   │ drift-triggered (PSI)   — inputs moved         │
   │ performance-triggered   — quality dropped      │
   └──────────────────────────────────────────────┘
        any fires ──► retrain; cron is the net under the reactive two
```
Anchor: "Three triggers — schedule, drift, performance — with the reactive two doing the real work and cron as the safety net."

**Q: "A retrain finished. Does it ship?"**
```
   challenger ──vs── champion   on the SAME labeled set
                  │
        better by a MARGIN? ── yes → promote ── no → rollback (keep champion)
```
Anchor: "Only if it beats the incumbent on the same labeled gate by a real margin — newer is never reason enough; that's what `eval/queries.json` is for."

**Q: "What's the hardest part to get right, and do you have it?"**
```
   most candidates: automate the retrain ◄── the easy half
   the gate: a LABELED validate-vs-incumbent check ◄── the hard half
        buffr HAS it: eval/queries.json → P@1/R@3
```
Anchor: "Most candidates have only consumed pre-trained models and would automate a retrain with no real gate. The hard part is the labeled champion/challenger check — and buffr already has that asset in `eval/queries.json`; what's missing is the model in front of it. That's the [B3.16] ceiling."

## See also

- ./15-drift-detection.md — the drift trigger that feeds this pipeline.
- ./14-training-run-logging.md — the reproducible rebuild every challenger must be.
- ./13-quantization.md — a promoted challenger gets quantized before it serves.
- ./08-confusion-matrices.md — the metric family the gate reads challenger vs champion off of.
- ./03-train-val-test.md — the held-out discipline the labeled gate depends on.
- ../03-retrieval-and-rag/10-incremental-indexing.md — the retrieval-side cousin: refreshing the index instead of the model.
- ../05-evals-and-observability/01-eval-set-types.md — `eval/queries.json` as the labeled gate type.
- ../06-production-serving/05-retry-circuit-breaker.md — rollback as the serving-side safety the gate mirrors.
- ../09-ml-system-design-templates — the retraining loop as the continuous-training box in a system-design answer.
