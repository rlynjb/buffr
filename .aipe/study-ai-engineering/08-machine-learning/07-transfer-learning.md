# Transfer learning — fine-tuning a pretrained backbone

*Industry standard (transfer learning / fine-tuning). buffr does NO fine-tuning — but it already consumes transfer learning twice (gemma2:9b, nomic-embed-text), and its trajectory corpus is exactly the small target set a future fine-tune would use. This is buffr's ceiling — Not yet implemented.*

## Zoom out, then zoom in

Almost nobody trains a model from scratch anymore. You take a backbone someone else paid millions to pretrain on a huge general corpus, and you adapt it to your tiny target task with a fraction of the data and compute. buffr already lives on the *consume* side of this: `gemma2:9b` and `nomic-embed-text:v1.5` are pretrained backbones it uses as-is, with zero adaptation — the pure feature-extraction case. What it hasn't done is the *adapt* side, and it's sitting on the exact ingredient that would make it possible: `agents.messages`, the full-signal trajectory of every conversation, is the small target set a future fine-tune of gemma would learn from. That's buffr's ceiling.

```
  Zoom out — buffr consumes transfer learning; the FT step is the ceiling

  ┌─ Pretrained backbones (CONSUMED as-is — feature extraction) ─┐
  │  gemma2:9b (generation)   ·   nomic-embed-text:v1.5 (embed)  │
  │  ★ zero fine-tuning — pure transfer, used off the shelf ★    │ ← we are here
  └───────────────────────────────┬─────────────────────────────┘
                                  │ trajectories logged ↓
  ┌─ Trajectory corpus (EXISTS) ─▼──────────────────────────────┐
  │  agents.messages — 6 event types, replay-ordered            │
  │  src/supabase-trace-sink.ts persists every run              │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ would be the TARGET SET for ↓
  ┌─ Fine-tune (NOT DONE — the ceiling) ─▼──────────────────────┐
  │  adapt gemma on buffr's trajectories (SFT / LoRA)           │
  │  ★ the genuine rhyme: the corpus already exists ★           │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: **transfer learning** is reusing the representations a model learned on a big general task to bootstrap a small target task. You don't relearn "what language looks like" or "what bodies look like" — that's frozen in the backbone. You adapt only the part that's task-specific. This file teaches the mechanism (frozen backbone + new head, feature extraction vs full fine-tune vs LoRA), then makes the buffr connection the centerpiece: buffr is already a transfer-learning *consumer*, and its trace corpus is the missing target set for the adapt step it hasn't taken.

## Structure pass

**Layers:** the pretrained backbone (general knowledge) → the adaptation layer (frozen vs unfrozen split) → the new task head (your specific output).

**Axis — "is this layer reused as-is, or relearned for the target task?"**

```
  trace "reused or relearned?" up the stack

  ┌─ task head (top) ───────┐   RELEARNED — always trained on target data
  │  classifier / output    │   the only part feature-extraction touches
  └─────────────────────────┘
  ┌─ upper backbone layers ─┐   SOMETIMES unfrozen (full fine-tune)
  │  high-level features    │   adapt if target differs from source
  └─────────────────────────┘
  ┌─ lower backbone layers ─┐   REUSED as-is — edges, syntax, primitives
  │  low-level features     │   frozen; generic, transfer everywhere
  └─────────────────────────┘

  the deeper you go, the more general (and more reusable) the features
```

**The seam:** the frozen/unfrozen boundary is where the axis flips — below it, weights are reused unchanged; above it, weights are relearned on your data. *Where you draw that line* is the entire design decision of transfer learning. Draw it at the very top (freeze everything but the head) and you get feature extraction; draw it lower (unfreeze upper layers) and you get fine-tuning; insert tiny trainable adapters *between* frozen layers and you get LoRA. buffr's current line is drawn at the absolute top — it freezes the *whole* backbone and doesn't even train a head. The ceiling is moving that line down.

## How it works

### Move 1 — the mental model

You already know this shape from extending a class instead of rewriting it. You don't re-implement everything `EventEmitter` does — you inherit it and override the one method you need. Transfer learning is inheritance for neural networks: the pretrained backbone is the base class with all the general behavior already implemented, and you override only the top layer for your specific task. The strategy in one sentence: keep the expensive general representations, adapt only the cheap task-specific part.

```
  the pattern — frozen backbone + new head (inheritance for nets)

  ┌─ PRETRAINED BACKBONE (frozen) ──────────────┐
  │  layer 1 ──► layer 2 ──► ... ──► layer N     │  ← weights REUSED as-is
  │  (general representations, learned once)     │     (the "base class")
  └──────────────────────────┬───────────────────┘
                             │ features out
                             ▼
  ┌─ NEW HEAD (trained on YOUR small target set) ┐
  │  fresh layer(s) → your task's output          │  ← the only part you train
  └───────────────────────────────────────────────┘     (the "override")
```

### Move 2 — the step-by-step walkthrough

**Why it works — reuse the representations, adapt only the top.** A deep model trained on a huge corpus learns a hierarchy: the bottom layers capture generic primitives (in language: subword patterns, syntax; in vision: edges, textures), and only the top layers are task-specific. Those bottom-layer features are *general* — they're useful for almost any related task — so there's no reason to relearn them. You inherit them and spend your scarce target data adapting just the top. That's why transfer works with tiny datasets: you're not learning from zero, you're nudging an already-competent model.

```
  the feature hierarchy — general at the bottom, specific at the top

  TOP    ┌─ task-specific ──┐  "is this run a failure?"   ← relearn
         ├──────────────────┤
         │  high-level      │   phrases, intents           ← maybe adapt
         │  mid-level       │   syntax, structure          ← reuse
  BOTTOM │  low-level       │   subwords, tokens           ← reuse
         └──────────────────┘
  general knowledge is at the bottom → frozen → that's the free lunch
```

**Three strategies — how much of the backbone you let move.** The frozen/unfrozen line gives you a spectrum, and where you put it trades data-hunger against adaptation power.

```
  three strategies along the frozen/unfrozen line

  ┌─ FEATURE EXTRACTION ────────────────────────────────────────┐
  │  freeze ALL backbone · train only a new head                │
  │  least data, fastest, least adaptation                      │
  │  ← buffr is HERE (and freezes the head too: zero training)  │
  └──────────────────────────────────────────────────────────────┘
  ┌─ FULL FINE-TUNE ────────────────────────────────────────────┐
  │  unfreeze upper (or all) layers · train with LOW lr         │
  │  most data, most compute, most adaptation                   │
  └──────────────────────────────────────────────────────────────┘
  ┌─ LoRA / ADAPTERS (parameter-efficient) ─────────────────────┐
  │  freeze backbone · inject small trainable low-rank matrices │
  │  ~0.1–1% of params train · cheap · stackable · swappable    │
  └──────────────────────────────────────────────────────────────┘
```

*Feature extraction* freezes the whole backbone and trains only a fresh head on top — cheapest, least data, least adaptation. *Full fine-tune* unfreezes some or all of the backbone and trains with a deliberately *low* learning rate (so you nudge, not clobber, the pretrained weights — the classic bug is a high learning rate that erases everything the backbone knew, called catastrophic forgetting). *LoRA* (Low-Rank Adaptation) is the modern default for LLMs: freeze the giant backbone entirely and inject tiny trainable low-rank matrices alongside the frozen weights, so you train ~1% of the parameters and can swap adapters in and out.

```
  LoRA — train a tiny low-rank delta beside the frozen weight

  frozen weight W (huge, d×d)        trainable A (d×r) · B (r×d), r ≪ d
        │                                   │
        ▼                                   ▼
  output = W·x  +  (B·A)·x      ← only A,B update; W never moves
                  └── low-rank delta ──┘     ~0.1–1% of params trained
```

In pseudocode, fine-tuning is the same loop you know, with two new lines — freeze, and low learning rate:

```
  // INPUT: pretrained_backbone, small target set (x, y) pairs
  backbone = load_pretrained()              // gemma2:9b / nomic — the free lunch
  freeze(backbone.lower_layers)             // REUSE: don't touch general features
  head = new_trainable_head()               // RELEARN: your task's output
  for epoch in epochs:
    for (x, y) in target_set:
      features = backbone(x)                // forward through frozen layers
      pred = head(features)
      loss = loss_fn(pred, y)
      // low lr is load-bearing — high lr = catastrophic forgetting:
      update(head, loss, lr = 1e-4)         // (and unfrozen layers, if any)
  // OUTPUT: adapted model — backbone's knowledge kept, top specialized
```

**The economics — why a tiny target set is enough.** From-scratch training needs millions of examples because the model learns everything, including the generic representations. Transfer learning amortizes that: the backbone already paid for the generic part, so your target set only has to teach the *difference* between the general task and yours. That's why people fine-tune useful models on hundreds or a few thousand examples — buffr's trajectory corpus territory — instead of millions.

```
  the economics — target set teaches only the DELTA

  from scratch:  ████████████████████  millions of examples
                 (learns generic + specific from zero)

  transfer:      ░░░░░░░░░░░░░░░░  ██   backbone (paid) + tiny target set
                 reused for free       teaches only your task's difference
```

### Move 2.5 — current state vs future state (the buffr ceiling)

This is the load-bearing part of the file. buffr's *current* state is the leftmost strategy taken to its limit: it consumes two frozen backbones and trains *nothing*. Its *future* state — the ceiling — is using `agents.messages` as the small target set for a fine-tune of gemma.

```
  Phase A (today)                      Phase B (the ceiling — NOT done)
  ─────────────                        ──────────────────────────────────
  gemma2:9b consumed as-is             gemma fine-tuned on buffr's runs
  nomic-embed consumed as-is           (SFT, then maybe LoRA)
  zero training                        target set = agents.messages
  feature-extraction case, no head     trajectories → prompt/response pairs
  src/supabase-trace-sink.ts           same sink keeps logging the new runs
    just LOGS trajectories               → the corpus that feeds the FT
```

The migration cost is real and worth stating honestly: `agents.messages` captures the full-signal trajectory — all six `CapabilityEvent` types, replay-ordered by `event.timestamp` — which is what makes it usable for supervised fine-tuning at all. But it has *no preference labels and no reward signal*. So the honest ceiling is SFT (supervised fine-tuning on prompt→response pairs extracted from the trajectory), not RLHF. What doesn't change: the backbones stay pretrained, the sink keeps logging, the retrieval pipeline is untouched. You're adding an export + a fine-tune, not rebuilding buffr.

```
  why agents.messages is a usable target set (and what's missing)

  ┌─ src/supabase-trace-sink.ts — emit() over 6 event types ────┐
  │  step · tool_call_start · tool_call_end · model_usage ·     │
  │  warning · error    → persistMessage() into agents.messages │
  │  event.timestamp → created_at = DETERMINISTIC replay order  │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ extract prompt→response pairs
                                  ▼
  ┌─ SFT-ready dataset ─────────────────────────────────────────┐
  │  HAVE: full trajectory, replay order, tool calls + results  │
  │  MISSING: preference labels, reward signal → no RLHF, SFT   │
  └──────────────────────────────────────────────────────────────┘
```

### Move 3 — the principle

Don't relearn what's already learned. Transfer learning is the recognition that general representations are expensive to acquire and cheap to reuse, so the entire game is deciding *where to draw the frozen/unfrozen line* for your data budget. buffr is the clean illustration of both ends: it already lives at the frozen extreme (two backbones, zero adaptation), and its ceiling is moving that line down by one fine-tune — with the target set, `agents.messages`, already sitting in the database. The data exists; the adaptation doesn't. That gap *is* buffr's ceiling.

## Primary diagram

```
  Transfer learning — backbone reuse, the frozen line, buffr's ceiling (recap)

  ┌─ PRETRAINED BACKBONE (general corpus, paid once) ───────────┐
  │  gemma2:9b · nomic-embed-text   ← buffr CONSUMES both as-is │
  │  lower layers: generic primitives (reuse / freeze)          │
  └───────────────────────────────┬─────────────────────────────┘
                          frozen/unfrozen LINE = the design choice
                                  │
        ┌─────────────────────────┼──────────────────────────┐
        ▼                         ▼                          ▼
  FEATURE EXTRACTION        FULL FINE-TUNE              LoRA / ADAPTERS
  freeze all + new head     unfreeze upper, low lr      tiny low-rank delta
  ★ buffr is here ★         (catastrophic-forget risk)  ~1% params trained
        │
        │ buffr's CEILING (not done): adapt gemma on its own runs
        ▼
  ┌─ TARGET SET (EXISTS) ───────────────────────────────────────┐
  │  agents.messages — full-signal trajectory, replay-ordered   │
  │  via src/supabase-trace-sink.ts                             │
  │  → SFT prompt/response pairs · MISSING: preference/reward   │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

Transfer learning is the dominant paradigm in modern ML, and it's why a single lab's pretraining run (gemma, the nomic encoders) becomes infrastructure thousands of apps build on without retraining — buffr included. It started in vision (ImageNet-pretrained backbones fine-tuned on small task datasets, ~2014) and became total in NLP after the pretrain-then-fine-tune recipe (ULMFiT, BERT, then the GPT/Llama/Gemma generation). LoRA (Hu et al., 2021) is the piece that made fine-tuning a billion-parameter model affordable on commodity hardware: freeze the giant matrix, learn a low-rank delta beside it, train ~1% of the weights. The adjacent concept is domain adaptation (`06-domain-gap.md`) — fine-tuning *is* domain adaptation when your target set is in-domain data the backbone underperforms on, which is precisely buffr's mild embedder gap. And the trigger question — *when is the trajectory corpus big enough to fine-tune?* — is the retraining-pipeline question (`16-retraining-pipelines.md`). The genuine buffr rhyme is worth restating plainly: buffr is *already* doing transfer learning every single query (consuming two frozen backbones), and the only step between it and a custom model is an export of `agents.messages` plus an SFT run. This rhymes with contrl too, but more loosely — MediaPipe's pose model is itself a pretrained backbone you consumed as-is, the feature-extraction case in a vision medium; buffr just has the corpus to take the *next* step that contrl never had.

## Project exercises

> No curriculum file present; exercises derived from the codebase.

### Design the SFT dataset export from agents.messages

- **Exercise ID:** XFER-1 (Case B — fine-tuning not done; this is the ceiling's first step). **The lead exercise — buffr's strongest ML connection.**
- **What to build:** an exporter that reads the replay-ordered trajectory out of `agents.messages` and turns each conversation into supervised fine-tuning pairs — prompt (user turn + retrieved context + tool results) → response (the assistant's `step` content). Honestly document what's *present* (full trajectory, tool calls and results, deterministic order) and what's *missing* (no preference labels, no reward signal → SFT only, not RLHF).
- **Why it earns its place:** this is the single step that moves buffr off the feature-extraction extreme. The target set already exists in the database; this exercise proves you can shape it into a real SFT corpus and that you understand the honest limits of what that corpus can train.
- **Files to touch:** new `src/cli/export-sft.ts`; read the trajectory via the same DB pool pattern as `src/cli/eval-cmd.ts`; rely on the column semantics and replay order established in `src/supabase-trace-sink.ts` (`event.timestamp → created_at`, the six event types).
- **Done when:** the exporter emits a JSONL file of prompt/response pairs in replay order, with a written note on the missing preference/reward signal.
- **Estimated effort:** 1–2 days.

### Prototype a LoRA fine-tune plan with a corpus-size trigger

- **Exercise ID:** XFER-2 (Case B — fine-tuning not done).
- **What to build:** a written plan (not a training run) for a LoRA fine-tune of gemma over the XFER-1 export: which layers stay frozen, the adapter rank, the learning rate (low, to avoid catastrophic forgetting), and — the key part — the *trigger*: how many trajectories in `agents.messages` make the corpus "big enough" to bother, and how you'd measure that the fine-tune actually helped (eval against the held-out trajectories / the existing IR eval).
- **Why it earns its place:** it forces the economics and the trigger question — the same "when is it worth retraining?" decision that drives the retraining pipeline — applied to buffr's real, growing corpus. It connects transfer learning to the operational reality of *when* you pull the trigger.
- **Files to touch:** new `docs/lora-finetune-plan.md`; reference the export from `src/cli/export-sft.ts` (XFER-1) and the row count in `agents.messages`; tie the success metric to `src/cli/eval-cmd.ts`.
- **Done when:** the plan names the frozen/unfrozen split, the adapter config, the low learning rate, and a concrete corpus-size trigger with a success metric.
- **Estimated effort:** 1 day.

## Interview defense

**Q: Walk me through fine-tuning a pretrained model on a small dataset.**
Answer: I load the pretrained backbone and freeze the lower layers — those hold general representations I don't want to relearn. I attach a new head for my task, and I either train just the head (feature extraction) or unfreeze the upper layers and fine-tune them with a *low* learning rate so I nudge the weights instead of clobbering them. For a large model I'd use LoRA — freeze the backbone entirely, train a small low-rank delta beside it, ~1% of the parameters. The target set only has to teach the difference between the general task and mine, which is why a few thousand examples can be enough.

```
  load backbone → freeze lower → new head → train (low lr / LoRA)
                  └─ reuse general ─┘   └─ relearn only the delta ─┘
```

**Q: buffr trains nothing. How is it related to transfer learning at all?**
Answer: two ways. First, it's already a transfer-learning *consumer* — `gemma2:9b` and `nomic-embed-text` are pretrained backbones it uses frozen, the pure feature-extraction case. Second, and this is the ceiling: `agents.messages` captures the full-signal trajectory of every run — all six event types, replay-ordered by timestamp via `src/supabase-trace-sink.ts` — which is exactly the small target set a future SFT of gemma would learn from. **The part people forget: the corpus already exists in the database; the only thing missing is the fine-tune step and a reward signal. So it's SFT-able, not RLHF-able — the data is real but it has no preference labels.**

```
  consume backbones (now)  ──►  SFT on agents.messages (the ceiling, not done)
                                └─ corpus exists · no reward signal → SFT only
```

## See also

- `06-domain-gap.md` — fine-tuning is domain adaptation; the same frozen/adapt decision closes a domain gap.
- `16-retraining-pipelines.md` — the "when is the corpus big enough to fine-tune?" trigger (XFER-2).
- `14-training-run-logging.md` — the trace sink is the per-run logging the FT corpus is built from.
- `05-class-imbalance.md` — a fine-tuned run-classifier head still faces imbalance at eval.
- `../05-evals-and-observability/04-llm-observability.md` — the trajectory trace that is the FT corpus.
