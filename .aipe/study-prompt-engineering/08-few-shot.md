# 08 — Few-shot prompting

**Industry term:** few-shot prompting / in-context examples · *Language-agnostic* · **not yet exercised in buffr**

Honest up front: buffr does **zero-shot**. There is not a single example anywhere in the assembled prompt — `BASE_SYSTEM` is pure instruction, the tool catalog is schema-only. This file teaches the pattern and names the one place a single example would buy the most reliability on a 9B model, because that's the primary buildable target.

## Zoom out, then zoom in

You know that a unit test *showing* the expected output communicates more than a paragraph *describing* it. Few-shot is that: examples constrain output harder than instructions do, because the model pattern-matches the shape instead of interpreting prose. Here's where it would slot into buffr's prompt.

```
  Zoom out — where few-shot WOULD live

  ┌─ Prompt anatomy (assembled) ──────────────────────────┐
  │  1. system prompt (BASE_SYSTEM)                       │
  │  2. context injection (profile)                       │
  │  3. ★ FEW-SHOT EXAMPLES ★  ← empty in buffr today     │ ← the gap
  │  4. user message (question)                           │
  │  + tool catalog: "respond with ONLY a JSON object"   │ ← described, not shown
  └────────────────────────────────────────────────────────┘
```

Zoom in: few-shot means putting 3–5 worked input→output pairs in the prompt so the model copies the pattern. buffr's tool-call format is *described in prose* (`gemma-provider.js:99`) — exactly the spot one shown example would harden.

## Structure pass

**Layers:** instruction (what buffr has) vs example (what it lacks). **Axis — "constrain by telling or by showing?":**

```
  axis: "how is the output format constrained?"

  ┌─ BASE_SYSTEM ───────┐ by TELLING (instructions)        ← buffr
  ├─ tool-call format ──┤ by TELLING ("respond with ONLY…") ← buffr
  └─ few-shot examples ─┘ by SHOWING (worked pairs)         ← absent
```

**Seam:** the tell-vs-show boundary. On a weak model, telling drifts and showing sticks — so the absence of examples is exactly where format drift would originate.

## How it works

### Move 1 — the mental model

The kernel: a handful of input→output pairs, demonstrating the exact shape, placed before the real input. The model continues the pattern.

```
  Few-shot — show the shape, then ask

  ┌─ example 1 ─┐  input  → output (the exact format)
  ├─ example 2 ─┤  input  → output
  ├─ example 3 ─┤  input  → output
  └─ real input ┘  input  → [model continues the pattern]
```

### Move 2 — where it would land in buffr

**The highest-leverage spot: the tool-call format.** buffr tells the model the format in prose: *"respond with ONLY a single JSON object, no prose: {"tool": "<tool name>", "arguments": { ...arguments... }}"* (`gemma-provider.js:99`). One *shown* example would constrain harder:

```
  // hypothetical addition to buildSystemText — a single shown call
  Example — to search the knowledge base, respond with exactly:
  {"tool": "search_knowledge_base", "arguments": {"query": "author's job"}}
```

Why it would help here specifically: Gemma 2 9B is the kind of model that drifts on prose-described formats but locks onto shown ones. The whole retry-and-nudge machinery from [02](02-structured-outputs.md) exists to catch format drift; a few-shot example would *reduce the drift rate* at the source, so the retry fires less often.

**The second spot: format-sensitive answers.** If buffr later needs answers in a fixed shape (always "[source] claim" citation format), a couple of examples of a well-cited answer would enforce it better than the current "cite their sources" instruction — which, recall from [02](02-structured-outputs.md), is unenforced.

**When NOT to use it.** Open-ended generation (a creative summary) — examples there flatten variety, the opposite of what you want. And examples cost tokens (every one counts against the [04](04-token-budgeting.md) budget every turn), so 3–5 good examples beats 20 mediocre ones. On buffr's 7424-token input budget, a few-shot block is real spend.

### Move 3 — the principle

Examples constrain output more than instructions do, because the model matches a pattern instead of parsing a description. Reach for few-shot on classifiers and format-sensitive output; skip it on open-ended generation. The interaction worth remembering: a few-shot example can *be* the structured-output form itself — the example and the schema are the same artifact.

## Primary diagram

```
  buffr today (zero-shot) vs the buildable target (one-shot tool call)

  NOW                              TARGET
  ┌─ "respond with ONLY a    ┐     ┌─ "respond with ONLY a JSON…" ┐
  │   JSON object…"  (tell)  │     │  + Example: {"tool":"search_ │
  │  → drift → retry+nudge   │     │    knowledge_base","args":…} │
  └──────────────────────────┘     │  (show) → less drift, fewer  │
                                    │  retries                     │
                                    └──────────────────────────────┘
```

## Project exercises

### EX-08-A — Add a one-shot example to the tool-call prompt

- **Exercise ID:** EX-08-A
- **What to build:** A single worked `search_knowledge_base` call example appended to the tool catalog text. (Note: this lives in aptkit's `GemmaModelProvider`, which buffr consumes read-only — so the real buffr-side version is a downstream prompt-wrapper or an aptkit PR, not an in-repo edit.)
- **Why it earns its place:** Directly attacks the format-drift the [02](02-structured-outputs.md) retry machinery exists to catch; reduces nudge fire rate on a 9B model.
- **Files to touch:** conceptually `provider-gemma/.../gemma-provider.js` `buildSystemText`; in buffr, a wrapper or upstream change.
- **Done when:** an eval ([05](05-eval-driven-iteration.md)) shows a lower retry/nudge rate with the example present.
- **Estimated effort:** S.

### EX-08-B — Few-shot the citation format

- **Exercise ID:** EX-08-B
- **What to build:** 2–3 examples of a well-cited answer added to the prompt, demonstrating the `[source] claim` format.
- **Why it earns its place:** Citation is unenforced ([02](02-structured-outputs.md)); shown examples constrain it where the instruction doesn't.
- **Files to touch:** the system-prompt assembly; the answer-level eval from [05](05-eval-driven-iteration.md).
- **Done when:** citation rate (measured by the new eval) rises with the examples present.
- **Estimated effort:** M (requires the answer-level eval to exist first).

## Interview defense

**Q: This runs on a 9B model and describes its tool-call format in prose. What would you change?**

I'd add a single few-shot example of a tool call. Examples constrain output harder than instructions because the model pattern-matches the shape instead of interpreting a description — and a 9B model drifts on prose-described formats. The whole retry-and-nudge path exists to *catch* that drift; a shown example *reduces* it at the source.

```
  tell ("respond with ONLY JSON") → drift → retry
  show (one example call)          → less drift, fewer retries
```

Anchor: *"The cost is tokens — every example counts against the 7424-token input budget every turn — so 3–5 good ones, not 20. And I'd never few-shot open-ended generation; examples flatten the variety you actually wanted there."*

## See also

- [02-structured-outputs.md](02-structured-outputs.md) — the prose-described tool format an example would harden
- [04-token-budgeting.md](04-token-budgeting.md) — examples cost budget every turn
- [07-output-mode-mismatch.md](07-output-mode-mismatch.md) — an example of the exact mode as anti-drift
