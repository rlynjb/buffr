# 11 — Meta-prompting

**Industry term:** meta-prompting / LLM-authored prompts · *Language-agnostic* · **not exercised in buffr; canonical in aipe**

buffr doesn't use an LLM to write its prompts — its only prompt-shaped input is the human-authored profile. The canonical example lives next door: aipe, where markdown templates and slash commands lean on meta-prompting under the hood. This file teaches the pattern and points at the right anchor.

## Zoom out, then zoom in

You've used a code generator that scaffolds a component from a spec — the generator writes code you then review and edit. Meta-prompting is that for prompts: a human writes the goal, an LLM drafts the prompt, the human reviews and commits it. buffr's prompts are all hand-written; aipe's are generated-then-reviewed.

```
  Zoom out — meta-prompting across the portfolio

  ┌─ buffr (this repo) ────────────────────────────────────┐
  │  prompts: BASE_SYSTEM (aptkit, hand-written)           │ ← no meta-prompting
  │  profile: human-authored                               │
  └────────────────────────────────────────────────────────┘
  ┌─ aipe (sibling) ───────────────────────────────────────┐
  │  ★ slash commands compose prompts; templates generate  │ ← canonical
  │    prompts for downstream LLM calls ★                  │
  └────────────────────────────────────────────────────────┘
```

Zoom in: meta-prompting is using one LLM call to write or improve the prompt for another. The workflow is human-goal → LLM-draft → human-review → into-the-codebase.

## Structure pass

**Layers:** the goal (human) → the draft (LLM) → the committed prompt (human-reviewed). **Axis — "who authored this prompt?":**

```
  axis: "who wrote the prompt?"

  ┌─ buffr BASE_SYSTEM ─┐ HUMAN (aptkit author)         ← no meta-prompting
  ├─ buffr profile ─────┤ HUMAN (the user)              ← no meta-prompting
  └─ aipe templates ────┘ LLM-drafted, HUMAN-reviewed    ← meta-prompting
```

**Seam:** the review boundary. The LLM drafts; the human gates what enters the codebase. Skip the gate and you get prompts that read like model output instead of engineering specs.

## How it works

### Move 1 — the mental model

The kernel: human states the goal → LLM drafts a prompt → human reviews/edits → prompt is committed as source. The human gate is load-bearing — without it, LLM-authored prompts drift into vague, model-flavored prose.

```
  Meta-prompting — draft, gate, commit

  human goal ─► LLM drafts prompt ─► human REVIEW ─► committed prompt
                                          │ (the gate)
                                    reject / edit ──┘
```

### Move 2 — why buffr doesn't, and where it would

**buffr's prompts are hand-authored.** `BASE_SYSTEM` is four hand-written sentences in aptkit ([01](01-anatomy.md)). The profile is human-authored `me.md`-style content stored in `agents.profiles`. Nothing in buffr asks an LLM to write a prompt. That's appropriate for a four-sentence system prompt under low iteration pressure — meta-prompting saves time on *initial drafting of complex prompts*, not on small hand-tuned ones.

**The aipe anchor.** aipe is markdown-as-source-of-truth: prompt templates as code, slash commands as the interface, a describe→diagnose→act layering ([me.md system-design portfolio]). Its slash commands lean on meta-prompting — a command composes a prompt for a downstream LLM call rather than running a fixed string. That's the pattern done as a primary thesis, which is why aipe, not buffr, is the example here.

**When it saves time vs when it doesn't.** Saves time: initial drafting of a long, complex prompt where a blank page is the bottleneck. Doesn't: small tweaks, or prompts under high iteration pressure where you're already editing every word — the LLM round trip is overhead there. buffr's prompts are the second case, which is why hand-authoring is the right call.

**The risk.** The failure mode of meta-prompting: prompts that read like LLM output instead of engineering specs — hedgy, padded, full of "please ensure that you carefully." The human-review gate is what catches that. A committed prompt should read like a spec a human wrote, even if a model drafted it.

### Move 3 — the principle

Use an LLM to draft prompts, never to commit them — the human gate is the whole discipline. Meta-prompting buys a fast first draft of a complex prompt; it does not buy a finished prompt. The artifact that lands in the codebase should read like an engineering spec, which is exactly the bar a human reviewer enforces.

## Primary diagram

```
  meta-prompting — buffr (none) vs aipe (canonical)

  buffr                          aipe
  ┌─ human writes 4-sentence ┐   ┌─ slash command composes a    ┐
  │  BASE_SYSTEM directly    │   │  prompt for a downstream call │
  │  (low iteration, fine)   │   │  → human reviews the template │
  └──────────────────────────┘   └───────────────────────────────┘
```

## Project exercises

(Meta-prompting's buildable target lives in aipe, not buffr — this concept is anchored elsewhere by design. No buffr-side exercise; the cross-link to aipe is the action.)

## Interview defense

**Q: Does this system use an LLM to write its own prompts?**

No — buffr's prompts are hand-authored (a four-sentence system prompt and a human-written profile), which is right for low-iteration prompts. Meta-prompting saves time on *initial drafting of complex prompts*, not on small hand-tuned ones. The canonical meta-prompting example in my portfolio is aipe, where slash commands compose prompts for downstream LLM calls.

```
  human goal → LLM draft → HUMAN REVIEW (the gate) → committed prompt
```

Anchor: *"The load-bearing part is the human-review gate. Skip it and you get prompts that read like model output — hedgy and padded — instead of engineering specs. A model can draft a prompt; only a human should commit one."*

## See also

- [01-anatomy.md](01-anatomy.md) — the hand-authored `BASE_SYSTEM` this concept contrasts with
- [03-prompts-as-code.md](03-prompts-as-code.md) — prompts-as-code, which aipe makes its primary thesis
