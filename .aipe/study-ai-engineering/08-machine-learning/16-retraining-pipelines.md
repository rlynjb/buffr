# Retraining pipelines — deciding when and how to refresh a model

*Retraining pipelines / model-refresh triggers (continuous-training, CT in MLOps). Industry standard. buffr retrains nothing — not yet implemented — but two real refresh loops (re-embedding on a model swap, fine-tuning on trajectory volume) are buildable from existing buffr data.*

## Zoom out, then zoom in

A model ships, drifts (file 15), and eventually has to be refreshed. The hard part isn't the retraining itself — it's the *trigger*: deciding *when* a refresh is worth its cost, and running the new model through a gate so you don't deploy something worse. buffr refreshes nothing today, but it has two genuine refresh loops waiting to be built: re-embedding its corpus when the embedding model changes, and fine-tuning Gemma once enough good trajectories pile up.

```
  Zoom out — where a retraining loop would sit in buffr

  ┌─ Signals layer ─────────────────────────────────────────────┐
  │  PSI > 0.2 (file 15) · embedding_model version change ·     │
  │  agents.messages trajectory volume                          │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  a trigger fires
  ┌─ Retraining loop ─────────────▼──────────────────────────────┐
  │  ★ collect → split → RETRAIN → eval-gate → canary → promote ★│ ← we are here
  │  NOT IMPLEMENTED — buffr trains/refreshes nothing            │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  promote
  ┌─ Serving layer ───────────────▼──────────────────────────────┐
  │  Ollama / pg-vector-store now serve the refreshed artifact   │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: a **retraining pipeline** is the loop that turns a refresh *trigger* into a *safely deployed* new model. Three things make it: a trigger strategy (when), the retrain-and-validate loop (how), and a gate (don't ship a regression). buffr has the data two such triggers would fire on — an `embedding_model` version column and an accumulating trajectory log — and no loop wired to either.

## Structure pass

**Layers:** the trigger (when to refresh) → the retrain loop (build the candidate) → the gate (is it better?) → the rollout (canary → promote).

**Axis — "what decides this fires, and what could it cost if it's wrong?"** Trace the trigger question across the three strategies.

```
  trace "what fires the retrain, and what's the failure?" across strategies

  ┌─ SCHEDULED ──────────┐  a clock      fires every N days
  │  cron, no signal      │  fails by: wasteful (stale data) OR too late
  ├─ DRIFT-TRIGGERED ────┤  PSI > 0.2    fires on input shift (file 15)
  │  ties to file 15      │  fails by: blind to concept drift
  └─ PERFORMANCE-TRIG. ──┘  metric drop   fires on live-quality drop
     needs prod labels      fails by: needs ground-truth buffr lacks
```

**The seam:** the **eval gate** between "candidate trained" and "candidate deployed." Control flips there — before the gate the pipeline is *building*, after it the pipeline is *serving*. A retrained model that skips the gate can be strictly worse than what it replaces, and you'd never know until production. The gate is the one part you can't drop: it's what makes a retraining *pipeline* rather than a retraining *gamble*.

## How it works

### Move 1 — the mental model

You already know dependency-driven rebuilds: a CI pipeline rebuilds when a file changes, runs the test suite, and only deploys if tests pass. A retraining pipeline is that loop for models — a *trigger* (something changed), a *build* (retrain), a *gate* (eval must pass), a *deploy* (canary then promote). The only new idea is that the "trigger" can be a statistical signal (drift) rather than a file edit.

```
  the kernel — the trigger→retrain→gate→deploy loop

         ┌─────────────────────────────────────────────┐
         ▼                                             │
  ┌─ trigger ──┐   ┌─ collect+split ─┐   ┌─ retrain ─┐  │
  │ clock/drift│ → │ new data, fresh │ → │ candidate │  │
  │ /perf drop │   │ train/val/test  │   │  model    │  │
  └────────────┘   └─────────────────┘   └─────┬─────┘  │
                                               ▼        │
                          ┌─ EVAL GATE ─┐  pass? ──no──►│ discard, keep current
                          │ candidate > │
                          │  current?   │  yes
                          └──────┬──────┘
                                 ▼
                    ┌─ canary/shadow ─┐ → ┌─ promote ─┐
                    │ small % traffic │   │ full swap │
                    └─────────────────┘   └───────────┘
```

The loop closes: promote, then keep watching, and the next trigger restarts it.

### Move 2 — the step-by-step walkthrough

**The three trigger strategies — when to refresh.** Each answers "when" differently, and each fails differently.

```
  trigger strategies side by side

  SCHEDULED          retrain every N days, no matter what
    + dead simple, predictable cost
    − wasteful if nothing changed; stale if change is faster than N

  DRIFT-TRIGGERED    retrain when PSI > 0.2 (file 15)
    + only pays when inputs actually moved
    − blind to concept drift (PSI watches inputs only)

  PERFORMANCE-TRIG.  retrain when a live metric drops below threshold
    + fires on the thing you actually care about (quality)
    − needs production GROUND-TRUTH labels to measure live quality
```

Drift-triggered is the natural pairing for buffr because it leans on PSI (file 15) and needs no labels; performance-triggered is mostly off the table since buffr collects no production ground-truth.

**The full retrain-and-validate loop.** Once a trigger fires, the model doesn't just get swapped — it runs a gauntlet.

```
  Step-by-step: trigger fired → safe deploy

  1. collect new data        gather the fresh corpus / trajectories
  2. revalidate split        re-draw train/val/test (no leakage from prod)
  3. retrain                 produce the candidate artifact
  4. EVAL GATE               candidate must BEAT current on a held-out set ← the gate
  5. canary / shadow         route a small % (or mirror traffic) to candidate
  6. promote                 candidate becomes current; loop continues
```

Pseudocode for the trigger-to-promote decision:

```
  // input:  signal (PSI / clock / metric), current_model
  // output: deployed model (new or unchanged)
  function maybe_retrain(signal, current_model):
    if not trigger_fires(signal):        // when? — strategy-specific
      return current_model               // cheapest path: do nothing
    data = collect_new_data()
    train, val, test = revalidate_split(data)   // fresh split, no leakage
    candidate = retrain(train, val)
    if eval(candidate, test) <= eval(current_model, test):  // ← THE GATE
      return current_model               // candidate worse → discard, keep current
    promote_via_canary(candidate)        // small % first, then full
    return candidate
```

The gate (`if eval(candidate) <= eval(current)`) is the load-bearing line: drop it and a retrain that produced a *worse* model ships automatically, which is the classic "we retrained on bad fresh data and degraded production" incident.

**buffr loop A — re-embed on an embedding-model swap.** `agents.chunks` carries an `embedding_model` column (`src/pg-vector-store.ts:28`, default `'nomic-embed-text:v1.5'`). Embeddings from different models live in *incompatible vector spaces* — a query embedded with model B cannot be cosine-compared against chunks embedded with model A. So swapping the embedding model isn't a config change; it's a *re-embed-everything* trigger.

```
  buffr loop A — embedding model swap → re-embed pipeline

  embedding_model column changes: nomic-v1.5 → new-model
        │  TRIGGER: every chunk's vector is now in the WRONG space
        ▼
  re-embed all agents.chunks with the new model
        │  build a SHADOW set (new vectors) alongside the old
        ▼
  ATOMIC swap: queries point at new vectors only after ALL chunks re-embedded
        │  (mixed-space search = silently wrong results = the failure to avoid)
        ▼
  drop old vectors
```

The boundary condition is atomicity: if queries hit a half-re-embedded table, some chunks are in the old space and some in the new, and cosine search returns garbage with no error. The swap must be all-or-nothing.

**buffr loop B — fine-tune trigger on trajectory volume.** buffr's actual (unbuilt) ML ceiling is fine-tuning Gemma on its own conversation trajectories (file 07). `agents.messages` accumulates the full-signal trajectory of every run — that's the SFT corpus growing in place. The retraining trigger is volume-and-quality: fine-tune once enough *good* trajectories have piled up.

```
  buffr loop B — trajectory volume → fine-tune trigger

  agents.messages grows: every conversation appends its trajectory
        │  TRIGGER: count high-quality trajectories
        ▼
  if  count(clean, successful runs) ≥ N   AND   quality bar met
        │  (ties to file 15: don't SFT on a drifted/degraded corpus)
        ▼
  build SFT set from agents.messages → fine-tune gemma (file 07)
        │
        ▼
  EVAL GATE on eval/queries.json → promote only if it beats base gemma
```

The trigger is the missing piece between "we have the corpus" and "we fine-tune" — `agents.messages` is the corpus, but nothing decides *when* it's big and clean enough.

### Move 2.5 — current state vs future state

```
  Phase A (today)                        Phase B (a retraining loop exists)
  ─────────────                          ──────────────────────────────────
  embedding_model column tracked         swap triggers atomic re-embed (loop A)
  agents.messages accumulates            volume/quality triggers SFT (loop B)
  NO trigger, NO gate, NO rollout        trigger → retrain → eval-gate → promote
  swapping models would break silently   swap is safe (shadow + atomic cutover)
```

Both loops are buildable from data that already exists — an `embedding_model` column and a growing trajectory table. What's missing is the *control*: the trigger, the gate, the atomic cutover.

### Move 3 — the principle

A retraining pipeline is mostly a *decision* problem, not a training problem: when is a refresh worth its cost, and how do you avoid shipping a regression. The trigger strategy answers "when" (clock vs drift vs live-metric), and the eval gate answers "is the candidate actually better" — drop the gate and you've automated the deployment of worse models. buffr has the signals two triggers would fire on and no loop wired to either, so its model never refreshes and its swap path is silently unsafe.

## Primary diagram

```
  buffr's two retraining loops — full picture

  ┌─ TRIGGER signals ───────────────────────────────────────────┐
  │  PSI > 0.2 (file 15) · embedding_model change · msg volume   │
  └──────────────┬───────────────────────────┬───────────────────┘
                 │ loop A: model swap          │ loop B: trajectory volume
                 ▼                             ▼
  ┌─ re-embed pipeline ─────────┐  ┌─ fine-tune pipeline (file 07) ─────┐
  │ re-embed all agents.chunks  │  │ build SFT set from agents.messages │
  │ shadow set → ATOMIC swap    │  │ fine-tune gemma                    │
  └──────────────┬──────────────┘  └──────────────┬─────────────────────┘
                 ▼                                 ▼
  ┌─ EVAL GATE ─────────────────────────────────────────────────┐
  │  candidate must beat current on eval/queries.json           │
  │  fail → discard, keep current   pass → canary → promote     │
  └───────────────────────────────┬──────────────────────────────┘
                                  ▼
  ┌─ Serving layer ───────────────────────────────────────────────┐
  │  pg-vector-store (new vectors) / Ollama (fine-tuned gemma)    │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

Retraining pipelines are the "CT" in MLOps' CI/CD/CT — continuous training — and the discipline is the same as deployment safety: never ship an artifact that hasn't passed a gate. The three trigger strategies trade cost against freshness. Scheduled is the simplest and the default people start with; it's wasteful when nothing changed and dangerous when change outpaces the schedule. Drift-triggered (retrain when PSI crosses 0.2, straight from file 15) only pays when inputs actually moved, but inherits PSI's blind spot — it won't fire on concept drift. Performance-triggered is the gold standard because it fires on the metric you actually care about, but it needs production ground-truth labels to measure live quality, which most systems — buffr included — don't collect.

buffr's two real loops are worth being precise about. Loop A (re-embed) is forced by a property of embeddings: different models produce vectors in *incompatible spaces*, so the `embedding_model` column (`src/pg-vector-store.ts:28`) isn't just metadata — it's a correctness invariant. Change it without re-embedding and cosine search silently compares incompatible vectors. The pipeline is a re-embed-everything job with an atomic cutover so queries never see a half-migrated table. Loop B (fine-tune) is buffr's ceiling: `agents.messages` is a fine-tuning corpus growing in place (file 14 logs it, file 07 would consume it), and the only missing piece is a *trigger* — a rule for "the corpus is now big and clean enough to SFT on." That trigger ties back to file 15: you don't want to fine-tune on a drifted or degraded corpus, so quality-gating the trajectories is part of the trigger.

buffr's prior ML pipeline (MediaPipe pose-landmarking) never retrained anything — it ran a fixed pre-built model — so the entire retraining-loop discipline is new ground here. The honest summary: buffr has both corpora (chunks and trajectories) and both version signals (`embedding_model`, message volume), and zero machinery to act on them.

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Design the re-embed pipeline triggered by an embedding-model change

- **Exercise ID:** RETRAIN-1 (Case B — re-embed pipeline not yet exercised). **The lead retraining exercise.**
- **What to build:** a pipeline that detects an `embedding_model` version change, re-embeds every row in `agents.chunks` with the new model into a shadow set, and swaps atomically so queries never hit a mixed-space table.
- **Why it earns its place:** swapping embedding models without re-embedding silently breaks cosine search (incompatible vector spaces, no error) — this is a real correctness trap buffr is one config change away from. The story is "I built a zero-downtime re-embed with atomic cutover."
- **Files to touch:** new `scripts/reembed.ts`; read/write `agents.chunks` via `src/pg-vector-store.ts` (the `embedding_model` column at L28, the `upsert` path); stage new vectors, then atomically repoint search.
- **Done when:** changing the embedding model re-embeds all chunks and queries only see the new space after the full re-embed completes (never a mix).
- **Estimated effort:** 1–2 days.

### Design the fine-tune trigger keyed on trajectory volume and quality

- **Exercise ID:** RETRAIN-2 (Case B — fine-tune trigger not yet exercised).
- **What to build:** a trigger rule over `agents.messages` — fire a fine-tune when the count of *clean, successful* trajectories crosses N and a quality bar is met — turning buffr's accumulating trace into an SFT trigger (ties to file 07 and file 15).
- **Why it earns its place:** `agents.messages` is buffr's fine-tuning corpus growing in place; the missing piece is *when is it big and clean enough to SFT*. This is the retraining trigger for buffr's actual unbuilt ceiling.
- **Files to touch:** new `scripts/ft-trigger.ts` reading `agents.messages` (filter for successful runs: no `error` rows, completed trajectory); reuse the PSI/quality checks from file 15; emit a "fine-tune now" flag with the candidate SFT set.
- **Done when:** the trigger fires only when ≥ N high-quality trajectories exist and the corpus passes the quality bar, naming the SFT set it would train on.
- **Estimated effort:** 1 day.

## Interview defense

**Q: What triggers a retrain, and which fits buffr?**
Answer: three strategies. Scheduled — retrain every N days, simple but wasteful or stale. Drift-triggered — retrain when PSI crosses 0.2 (file 15), only pays when inputs move but blind to concept drift. Performance-triggered — retrain when a live quality metric drops, the gold standard but it needs production ground-truth labels. For buffr, drift-triggered fits because it leans on PSI and needs no labels; performance-triggered is mostly off the table since buffr collects no production ground-truth.

```
  scheduled (clock) · drift (PSI>0.2) · performance (metric drop, needs labels)
  buffr → drift-triggered (no labels required)
```

**Q: buffr swaps its embedding model — what has to happen, and what's the trap?**
Answer: every chunk must be re-embedded. Embeddings from different models live in incompatible vector spaces, so a query embedded with the new model can't be cosine-compared against chunks still embedded with the old one — `agents.chunks.embedding_model` tracks which model produced each vector for exactly this reason. The pipeline re-embeds all chunks into a shadow set and cuts over atomically. **The part people forget: the cutover must be all-or-nothing — if queries hit a half-re-embedded table, search compares mixed spaces and returns silently wrong results with no error to catch it.**

```
  model swap → re-embed ALL chunks (shadow) → ATOMIC cutover
  half-migrated table = mixed-space search = silent garbage
```

## See also

- `15-drift-detection.md` — the PSI signal that drives drift-triggered retraining.
- `07-transfer-learning.md` — the fine-tune that loop B (RETRAIN-2) triggers; buffr's ML ceiling.
- `14-training-run-logging.md` — `agents.messages`, the trajectory corpus loop B trains on.
- `13-quantization.md` — you'd quantize a fine-tuned model before serving it; the step after retraining.
- `../05-evals-and-observability/04-llm-observability.md` — the trace that supplies both the trigger signal and the SFT corpus.
