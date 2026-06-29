# Transfer Learning

### *industry: transfer learning · type: reusing a model pretrained on large public data, then adapting it to a small domain set*

## Zoom out

You will almost never train a serious model from scratch — you can't afford the data or the compute, and you don't need to. Modern ML is mostly *adaptation*: take a model that already learned general structure from a giant public corpus, and bend it toward your small, specific task. This is the most quietly important file in the section, because buffr is already standing on its output. See where it lands in the pipeline:

**The supervised pipeline, with the stage transfer learning replaces marked**
```
┌────────┐  ┌──────────┐  ┌───────┐  ┌──────────────────────────┐  ┌────────┐
│  Data  │─►│ Features │─►│ Split │─►│ ★ TRAIN (from a PRETRAINED │─►│ Deploy │ ◄── this file
│ (SMALL │  │ (learned │  │       │  │   base, not from scratch) ★│  │        │
│  domain│  │  by base)│  │       │  │   feature-extract / FT / LoRA│  │       │
│  set)  │  │          │  │       │  └──────────────────────────┘  └────────┘
└────────┘  └──────────┘  └───────┘            ▲
                                    a giant PUBLIC pretrain already happened
                                    upstream; you start from its weights
```
Transfer learning swaps "fit from zero on my data" for "start from a model that already knows a lot, then nudge it" — and that nudge needs orders of magnitude less data.

## Structure pass

One axis governs every transfer-learning decision: **how many of the pretrained weights you allow to move.** That single dial spans the whole method space.

**The one axis: fraction of pretrained weights you let update**
```
   weights you allow to change during adaptation
   0% ──────────── tiny % ──────────────────────── 100%
   │               │                                │
   FEATURE         LoRA / ADAPTERS                  FULL FINE-TUNE
   EXTRACTION      (freeze base, train a few        (every weight moves)
   (freeze base,    small inserted matrices)
    train only a
    new head)

   ┌──────────────────────────── THE SEAM ──────────────────────────────┐
   │ more weights moving = more capacity to adapt, BUT more data needed  │
   │ and more risk of catastrophic forgetting + overfitting your small   │
   │ domain set. The right point is set by HOW MUCH LABELED DATA YOU HAVE.│
   └─────────────────────────────────────────────────────────────────────┘
```
The seam: the amount of labeled domain data you have decides how far right on this dial you're allowed to go — too far right with too little data and you destroy the general knowledge you were trying to keep.

## How it works

### Move 1 — Mental model

The mental model: **a pretrained network's early layers learned general structure; only its last layers are task-specific.** Edges and textures, or in language general syntax and semantics, live in the lower layers and transfer almost everywhere. The task-specific decision lives near the top. Transfer learning keeps the reusable bottom and replaces or lightly adjusts the top. Hold contrl pose-landmarking in mind: that's the from-scratch shape; transfer learning is "don't start at zero — start from a vision backbone that already sees."

**General-bottom, specific-top — keep the bottom, swap the top**
```
   ┌───────────────────────────┐
   │  HEAD (task-specific)      │  ◄── REPLACE / RETRAIN this (your classes)
   ├───────────────────────────┤
   │  upper layers (specific)   │  ◄── maybe fine-tune (if you have data)
   ├───────────────────────────┤
   │  middle layers (mixed)     │  ◄── usually FREEZE
   ├───────────────────────────┤
   │  lower layers (general:    │  ◄── almost always FREEZE — edges, syntax,
   │  edges / syntax / texture) │       general structure transfer everywhere
   └───────────────────────────┘
        ▲ keep the reusable bottom, it was the expensive part to learn
```
You're buying the lower layers for free and paying only to teach the top your specific task.

### Move 2 — Walk the mechanism

**Part 1 — The base model is pretrained on a giant public corpus.** This already happened, off your machine, at a scale you can't match. nomic-embed-text and gemma2 both arrive this way.

**Pretrain happened upstream — you inherit the weights**
```
   billions of public tokens / images  ──►  [ PRETRAIN, weeks of GPUs ]  ──► W₀
                                                                            │
                          you START HERE, downloading W₀ ◄──────────────────┘
                          (you did NOT pay for any of the above)
```

**Part 2 — You choose how much to thaw.** This is the central decision. Illustrative pseudocode, not buffr code:

**The three regimes, as a dial on what's frozen (illustrative)**
```python
# ILLUSTRATIVE ONLY — not buffr code. The three transfer regimes.

# (1) FEATURE EXTRACTION — freeze everything, train a fresh head.
for p in base.parameters(): p.requires_grad = False
head = LinearClassifier(base.output_dim, n_classes)   # only this trains

# (2) FULL FINE-TUNE — unfreeze all, tiny learning rate.
for p in base.parameters(): p.requires_grad = True
optimizer = Adam(base.parameters(), lr=1e-5)          # small LR = don't forget

# (3) LoRA / ADAPTERS — freeze base, inject + train small matrices.
#     W_eff = W_frozen + (B @ A)   where A,B are tiny, low-rank, trainable
inject_lora(base, rank=8)                              # ~0.1% of params train
```

**Part 3 — The data-vs-method match decides which regime is correct.** This is the rule you defend in interviews.

**Pick the regime from your data size and domain distance**
```
                    small labeled set        large labeled set
   close to        ┌────────────────────┐   ┌────────────────────┐
   pretrain        │ FEATURE EXTRACTION │   │ fine-tune upper few │
   domain          │ (freeze, train head)│   │ layers              │
                   └────────────────────┘   └────────────────────┘
   far from        ┌────────────────────┐   ┌────────────────────┐
   pretrain        │ LoRA / adapters     │   │ FULL FINE-TUNE      │
   domain          │ (cheap, low-risk)   │   │ (you can afford it) │
                   └────────────────────┘   └────────────────────┘
```

**Part 4 — Full fine-tuning risks catastrophic forgetting; LoRA sidesteps it.** Moving every weight on a small set can erase the general knowledge. LoRA freezes the base entirely, so the original capability is structurally preserved.

**Why LoRA is the safe default for small domain sets**
```
   FULL FINE-TUNE on small data:
     W₀ ──drift──► W'   general knowledge can be OVERWRITTEN (forgetting)

   LoRA:
     W₀ (FROZEN) + ΔW(tiny, trainable)  ──►  base intact, adaptation additive
     │                                         ┌──────────────────────────┐
     └─ original capability cannot be lost     │ ~0.1–1% of params train; │
        because W₀ never moves                 │ adapters are swappable    │
                                               └──────────────────────────┘
```

### Move 2.5 — current vs future

**The biggest honest hook in this whole section, drawn straight**
```
   ALREADY TRUE (real, shipping)                  THE CEILING (Case B — not built)
   ┌──────────────────────────────────┐           ┌──────────────────────────────────┐
   │ the EMBEDDINGS buffr serves ARE   │           │ FINE-TUNE gemma2 (LoRA/QLoRA) on  │
   │ the output of a transfer-learned  │           │ buffr's CAPTURED TRAJECTORIES.    │
   │ model:                            │           │                                   │
   │   nomic PRETRAIN (web text)       │           │ corpus lives in agents.messages   │
   │        │ contrastive TUNE         │           │ ── "capture every conversation as │
   │        ▼                          │           │    a trajectory NOW so fine-tuning │
   │   nomic-embed-text:v1.5  ◄─buffr  │           │    is ANSWERABLE later"            │
   │   consumes this every retrieval   │           │    (agent-layer-plan.md, verbatim) │
   └──────────────────────────────────┘           └──────────────────────────────────┘
        ▲ buffr STANDS ON transfer learning            ▲ it is a DATASET that does
          but trained none of it                          NOT yet train anything
```
Two honest truths at once: buffr is *already built on* a transfer-learned model (the embeddings), and its realistic *ceiling* is fine-tuning gemma on `agents.messages` — a corpus that exists to make fine-tuning answerable, while training nothing today.

### Move 3 — The principle

The principle: **start from the most knowledge you can inherit, and move the fewest weights that get the job done.** Every weight you thaw costs data and risks erasing what you were trying to keep. From-scratch training is the exception you justify, not the default you reach for — and the cheaper the adaptation that hits your bar, the better the engineering.

## Primary diagram

**The whole picture: inherit, choose how much to thaw, adapt**
```
   PUBLIC PRETRAIN (upstream, not yours)
   ┌────────────────────────────────────┐
   │  giant corpus ──► W₀ (general)      │   nomic, gemma2 both arrive here
   └──────────────────┬─────────────────┘
                      │ you download W₀
                      ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │  ADAPT — turn the dial by how much labeled DOMAIN data you have:       │
   │                                                                        │
   │   none of base moves ◄──── FEATURE EXTRACT ──── LoRA ──── FULL FT ────► all moves │
   │     (tiny data, close)        (cheap, safe)            (lots of data)   │
   └──────────────────┬─────────────────────────────────────────────────────┘
                      ▼
   ┌────────────────────────────────────┐
   │  DEPLOY adapted model               │   ★ buffr's ceiling: LoRA gemma on
   │  (small domain set, big knowledge)  │     agents.messages — dataset only, today
   └────────────────────────────────────┘
```
Inherit the expensive general knowledge for free, then spend the minimum adaptation that clears your bar.

## Elaborate

The sharp edges:

- **Embeddings are applied transfer learning.** The 768-dim vectors buffr retrieves over (`03-retrieval-and-rag/01-embeddings.md`) are produced by a model that was pretrained then contrastively tuned. When you use those vectors, you are consuming transfer learning's output — this file is the upstream of that one.
- **LoRA is the default for one developer.** Full fine-tuning a 9B model needs serious GPUs and risks forgetting. LoRA/QLoRA trains ~0.1–1% of parameters, fits on modest hardware, and keeps the base intact and swappable. For buffr's ceiling exercise, it's the only realistic option — and `agent-layer-plan.md` already names LoRA/QLoRA as the furthest it would go.
- **Catastrophic forgetting is real and quiet.** Full fine-tune on a small domain set and the model can get better at your task while getting worse at everything else — and your domain eval won't show the loss. Test general capability after fine-tuning, not just domain capability.
- **A fine-tuning dataset is not a trained model.** This is the honesty line for the whole section: `agents.messages` accumulating trajectories is a *latent corpus*. It makes fine-tuning *answerable*; it trains nothing. Saying "we capture trajectories so we could fine-tune later" is accurate; saying "buffr fine-tunes gemma" is not.
- **Fine-tune only when evidence demands it.** Per `agent-layer-plan.md`, the decision to fine-tune is gated on Phase-4 eval evidence — you fine-tune because P@1/faithfulness numbers told you to, not because it's the exciting option.

## Project exercises

### Build a LoRA fine-tune harness over captured trajectories (the ceiling)

- **Exercise ID:** [B2C.7] Phase 3 (gated on trajectory volume)
- **What to build:** Not yet implemented — buffr trains nothing. Build a `ml/` harness that turns `agents.messages` into a supervised fine-tuning dataset (prompt → preferred response pairs) and runs a LoRA/QLoRA fine-tune of a small base model on it. Start tiny: prove the data-prep and training loop end-to-end on a few hundred trajectories before scaling. This is the *first time buffr would train anything* — implement it honestly as new code, gated on having enough captured trajectories.
- **Why it earns its place:** It is buffr's stated ceiling, drawn directly from `agent-layer-plan.md`. Owning the data-prep → LoRA → eval loop is exactly the "trained one, not just consumed one" signal interviews reward, and it forces the catastrophic-forgetting and regime-choice lessons into your hands.
- **Files to touch:** new `ml/trajectory_dataset.py` (reads `agents.messages`, emits SFT pairs), new `ml/lora_finetune.py`, new `ml/eval_finetuned.py` reusing `eval/queries.json` for before/after numbers.
- **Done when:** a tiny LoRA adapter trains to completion on a real trajectory slice; an eval compares base vs adapted on `eval/queries.json` AND on a held-out general-capability probe (to catch forgetting); a note states whether the evidence would justify shipping it.
- **Estimated effort:** 3–5 days; the data-prep and the honest before/after eval are the bulk.

### Feature-extraction baseline: embeddings + a trained head

- **Exercise ID:** [B2C.7b] Phase 2C
- **What to build:** Not yet implemented — buffr trains nothing. The cheap, correct first rung of transfer learning: freeze `nomic-embed-text`, use its embeddings as fixed features, and train only a small classifier head on top (e.g. query-intent from [B2C.5]). This is feature-extraction transfer learning with zero fine-tuning — you adapt a pretrained model by training nothing in it, only a head on its output.
- **Why it earns its place:** It's the lowest-risk, highest-ratio form of transfer learning and the honest entry point: it teaches that "using embeddings as features and training a head" *is* transfer learning, which most people don't realize they're already doing.
- **Files to touch:** new `ml/feature_extract_head.py` (embeds corpus via nomic, trains a head), reuses `ml/labels.json`, results to `ml/README.md`.
- **Done when:** a head trains on frozen nomic embeddings and beats a bag-of-words baseline; a one-line note frames this explicitly as feature-extraction transfer learning and names what it would cost to thaw the base instead.
- **Estimated effort:** 1 day (a natural extension of [B2C.5]).

## Interview defense

Most candidates have only *consumed* transfer-learned models (every embedding API is one). Having run feature-extraction or LoRA yourself — and chosen the regime from your data — is the signal.

**Q: You have 500 labeled examples in a niche domain. Train from scratch, fine-tune, or feature-extract?**
```
   500 examples = TINY ─► never from scratch
        │
        ├─ domain close to pretrain? ─► FEATURE EXTRACTION (freeze, train head)
        │
        └─ domain far?               ─► LoRA (cheap, low-risk adaptation)
                                         full fine-tune would overfit + forget
```
Anchor: data size and domain distance pick the regime; 500 examples never earns a from-scratch run.

**Q: What's the risk of full fine-tuning, and how does LoRA reduce it?**
```
   full FT on small data ─► catastrophic forgetting (base knowledge overwritten)
        │
   LoRA: W₀ frozen + small ΔW trainable
        └─► base CANNOT be lost (it never moves); adaptation is additive
            and the adapter is swappable
```
Anchor: full fine-tuning can erase what you were keeping; LoRA freezes the base so it structurally can't.

**Q: Does buffr do transfer learning?**
```
   honest, two-part answer:
     ① it CONSUMES it — its embeddings are a transfer-learned model's output
     ② its CEILING is LoRA-fine-tuning gemma on agents.messages
        ── that corpus exists to make fine-tuning ANSWERABLE; it trains
           nothing today (agent-layer-plan.md frames it exactly this way)
```
Anchor: buffr stands on transfer learning's output and captures the dataset for more — but trains none of it yet.

## See also

- `./06-domain-gap.md` — fine-tuning on a small in-domain set is the heavyweight mitigation for a measured domain gap.
- `./08-confusion-matrices.md` — how you'd read a before/after fine-tune comparison per class.
- `../03-retrieval-and-rag/` — `01-embeddings.md`: the transfer-learned model buffr consumes every retrieval.
- `../05-evals-and-observability/` — `eval/queries.json` as the before/after harness; `agents.messages` as the latent fine-tuning corpus.
- `../09-ml-system-design-templates/` — where "do we fine-tune?" becomes a gated, evidence-driven system decision.
