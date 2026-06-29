# 03 — Prompts as code: versioning and observability

**Industry term:** prompts-as-code / prompt versioning + observability · `BASE_SYSTEM` pinned in a dependency + the trace sink (`SupabaseTraceSink`) · *Industry standard*

## Zoom out, then zoom in

You already version-control a `migrations/0003_chunks.sql` file — it's reviewed, diffed, pinned to a deploy. A prompt deserves the same treatment, because a prompt change is a behavior change exactly like a schema change. The twist in buffr: the prompt *is* code, but it's pinned code that lives in someone else's repo.

```
  Zoom out — where the prompt-as-code lives

  ┌─ App layer (buffr repo) ──────────────────────────────┐
  │  package.json: "@rlynjb/aptkit-core": "^0.4.1"        │ ← the pin
  │  agents.profiles rows  (the only prompt-shaped source │
  │  that lives IN this repo's database)                  │
  └─────────────────────────┬──────────────────────────────┘
                            │  resolves to
  ┌─ Dependency (node_modules) ▼──────────────────────────┐
  │  ★ BASE_SYSTEM lives HERE ★  rag-query-agent.js:12    │ ← we are here
  └─────────────────────────┬──────────────────────────────┘
                            │  every run emits a trajectory
  ┌─ Storage (agents.messages) ▼──────────────────────────┐
  │  full-signal trace: steps, tool calls, model, tokens   │
  └────────────────────────────────────────────────────────┘
```

Zoom in: prompts-as-code means file-per-prompt, version-controlled, reviewed, paired with a model version, and observable in production. buffr does part of this well (trajectory observability) and part of it not at all (prompt versioning of `BASE_SYSTEM`).

## Structure pass

**Layers:** the pin (`package.json`) → the prompt text (`node_modules`) → the trace (`agents.messages`). **Axis — "can I diff this prompt and tie it to an output?":** trace it and the gap appears.

```
  axis: "is this prompt diffable + tied to its output?"

  ┌─ BASE_SYSTEM ─┐ diffable? only via aptkit version bump  ┐
  ├─ profile rows ┤ diffable? yes (DB rows, updated_at)     ┤ partial
  └─ each output  ┘ tied to prompt version? NO              ┘ the gap
```

**Seam:** the version boundary. `BASE_SYSTEM` changes only when you bump `^0.4.1` — so a prompt change to buffr's behavior arrives as a *dependency upgrade*, which is a real prompt+model-version pairing risk.

## How it works

### Move 1 — the mental model

Treat the prompt the way you treat a function: source-controlled, reviewed, deployed deliberately. The shape buffr has is "prompt pinned upstream, trajectory logged downstream."

```
  Prompt-as-code — the two halves, one present, one partial

  VERSIONING                          OBSERVABILITY
  ┌────────────────────┐              ┌────────────────────┐
  │ BASE_SYSTEM pinned │   present?   │ every turn's full  │
  │ via ^0.4.1         │   partial    │ trajectory persists│  present ✓
  │ profile in DB rows │              │ steps/tools/tokens │
  └────────────────────┘              └────────────────────┘
        ▲ no per-output                      ▲ but no prompt-
          version stamp                        version stamp on it
```

### Move 2 — the walkthrough

**The prompt lives in a pinned dependency.** `BASE_SYSTEM` is a constant in `@rlynjb/aptkit-core`, pinned `^0.4.1`. buffr's must-not-change constraint is explicit: *"aptkit is consumed, never edited here"* (`context.md`). So the canonical system prompt is reviewable and diffable — but only by reading aptkit's source and bumping the version. A prompt change to buffr's grounding behavior is a `npm update` away, not a one-line edit.

**The profile is the prompt-shaped source buffr DOES own.** Profile rows in `agents.profiles` (read by `loadProfile`, `src/profile.ts:4`) carry `updated_at`, and `loadProfile` takes the most recent. That's a crude version history — you can see *when* the personalization text last changed, though not diff two versions in a PR.

**Observability is real, at the trajectory level.** Every turn persists its full signal through `SupabaseTraceSink` into `agents.messages` — all six `CapabilityEvent` types (step, tool_call_start/end, model_usage, warning, error), with `model` and `tokens_used` populated and `created_at` from the event timestamp for deterministic replay (`context.md`, `src/supabase-trace-sink.ts`).

```js
// run-agent-loop.js:37 — the trace the sink persists
trace?.emit({ type: 'model_usage', provider: model.id,
  model: response.model ?? ..., inputTokens, outputTokens, ... });
```

The boundary condition: you can replay *what happened* on any turn (which tools fired, how many tokens, what the model said) — but you cannot answer "which version of `BASE_SYSTEM` produced this output," because no prompt-version stamp rides on the message row. That's the missing half.

### Move 2.5 — current vs future state

```
  Phase A (now)                 Phase B (the buildable target)
  ─────────────                 ──────────────────────────────
  prompt pinned in aptkit       prompt-version field on each
  ^0.4.1                        agents.messages row
  trajectory logged             + aptkit version captured
  no per-output prompt stamp    → "which prompt made this output?"
                                  answerable in a SQL query
```

What doesn't have to change: the trace sink already captures the trajectory. Adding a `prompt_version` column and stamping it is additive — the observability spine is built.

### Move 3 — the principle

A prompt is a behavior contract; version it like one. The prompt+model-version pairing is the part that bites: a prompt tuned for Gemma 2 9B is not guaranteed to survive a model swap, and a system that can't tie an output back to the exact (prompt, model) pair that produced it can't debug a regression after the fact.

## Primary diagram

```
  buffr's prompt-as-code — what's versioned, what's observed

  PROMPT SOURCE                         PRODUCTION TRAJECTORY
  ┌─ BASE_SYSTEM (aptkit ^0.4.1) ─┐     ┌─ agents.messages ──────────┐
  │  reviewed via dependency bump  │     │  step · tool_call · usage  │
  ├─ profile rows (agents.profiles)│ ──► │  model · tokens_used       │
  │  updated_at = crude history    │     │  ✗ no prompt_version stamp │
  └────────────────────────────────┘     └────────────────────────────┘
       diffable: partial                      observable: trajectory yes,
                                              prompt-version no
```

## Elaborate

Prompts-as-code is the aipe project's entire thesis (markdown templates as version-controlled prompts, slash commands composing them) — that's the canonical example in this portfolio, and it's where [11-meta-prompting.md](11-meta-prompting.md) picks up. buffr inverts it: the prompt is upstream and pinned, the observability is downstream and rich. The prompt+model-version pairing risk is the one Simon Willison and the eval crowd hammer on — a prompt is only correct *relative to a model*, and model upgrades silently regress eval sets. buffr is one `gemma2:9b` → `gemma3` swap away from needing this.

## Interview defense

**Q: Where do this system's prompts live, and how would you ship a prompt change safely?**

The system prompt lives in a pinned dependency (`@rlynjb/aptkit-core ^0.4.1`), so a behavior change ships as a reviewed dependency bump. The personalization lives in DB rows with `updated_at`. Observability is strong at the trajectory level — every turn's tools, model, and tokens persist — but no prompt-version stamp ties an output back to the prompt that made it.

```
  pin (^0.4.1) → BASE_SYSTEM → output → trace ✓  but: which prompt? ✗
```

Anchor: *"The gap I'd close first is stamping each `agents.messages` row with the prompt + aptkit version. The trace sink already captures everything else — it's an additive column, and without it you can't debug a regression after a model upgrade."*

## See also

- [01-anatomy.md](01-anatomy.md) — the prompt sections being versioned
- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — why the prompt+model pairing needs evals to catch regressions
- [11-meta-prompting.md](11-meta-prompting.md) — aipe's prompts-as-code done as the primary thesis
