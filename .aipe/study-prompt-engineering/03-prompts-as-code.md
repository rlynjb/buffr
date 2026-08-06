# 03 — Prompts as code: versioning and observability

**Industry term:** prompts-as-code / prompt versioning + observability · `BASE_SYSTEM` pinned in a dependency + the trace sink (`SupabaseTraceSink`) · *Industry standard*

## Zoom out, then zoom in

You already version-control a `migrations/0003_chunks.sql` file — it's reviewed, diffed, pinned to a deploy. A prompt deserves the same treatment, because a prompt change is a behavior change exactly like a schema change. The twist in buffr: the prompt *is* code, and it lives in this repo — but in a sibling npm workspace package, one dependency edge away from the code that calls it.

```
  Zoom out — where the prompt-as-code lives

  ┌─ App layer (buffr root) ────────────────────────────────┐
  │  package.json: "@buffr/kernel": "0.0.1"  (workspace)    │ ← local pin,
  │  agents.profiles rows + domain-pack prompts.ts files    │   same repo
  └─────────────────────────┬──────────────────────────────┬─┘
                            │  resolves to           npm install -w
  ┌─ Workspace package (packages/kernel/src) ▼───────────────┐
  │  ★ BASE_SYSTEM lives HERE ★  agents/rag-query-agent.ts    │ ← we are here
  └─────────────────────────┬──────────────────────────────┬─┘
                            │  every run emits a trajectory
  ┌─ Storage (agents.messages) ▼──────────────────────────┐
  │  full-signal trace: steps, tool calls, model, tokens   │
  └────────────────────────────────────────────────────────┘
```

Zoom in: prompts-as-code means file-per-prompt, version-controlled, reviewed, paired with a model version, and observable in production. buffr does part of this well (trajectory observability, domain-pack prompts diffable in the same PR) and part of it not fully (a `promptVersion` is computed per turn but never persisted alongside the output it produced).

## Structure pass

**Layers:** the workspace pin (`package.json`) → the prompt text (`packages/kernel/src`, `packages/domain-packs/*/src`) → the trace (`agents.messages`). **Axis — "can I diff this prompt and tie it to an output?":** trace it and the gap appears.

```
  axis: "is this prompt diffable + tied to its output?"

  ┌─ BASE_SYSTEM ──────┐ diffable? yes, via a package source edit ┐
  ├─ domain-pack prompts┤ diffable? yes, PR on a plain .ts file    ┤ diffable,
  ├─ profile rows ──────┤ diffable? yes (DB rows, updated_at)      ┤ mostly
  └─ each output ───────┘ tied to prompt version? NO               ┘ the gap
```

**Seam:** not diffability — every prompt source in buffr is diffable now. The seam is the version-to-output tie: `agent.promptVersion` is computed per turn (`PromptRegistry`) but the value dies at the UI callback and never rides on the `agents.messages` row, so you can diff the prompt *sources* but can't answer "which version made *this* output" from the database alone.

## How it works

### Move 1 — the mental model

Treat the prompt the way you treat a function: source-controlled, reviewed, deployed deliberately. The shape buffr has is "prompt sources are all diffable, the version just doesn't survive the trip to the output row."

```
  Prompt-as-code — the two halves, one present, one partial

  VERSIONING                           OBSERVABILITY
  ┌─────────────────────┐              ┌────────────────────┐
  │ BASE_SYSTEM in a     │   present?   │ every turn's full  │
  │ workspace package;   │   computed,  │ trajectory persists│  present ✓
  │ domain-pack prompts  │   not        │ steps/tools/tokens │
  │ + routing prompt in  │   persisted  │                    │
  │ buffr's own source   │              │                    │
  └─────────────────────┘              └────────────────────┘
        ▲ agent.promptVersion                  ▲ but no prompt-
          computed, dies at UI callback           version stamp on it
```

### Move 2 — the walkthrough

**The prompt lives in a sibling workspace package.** `BASE_SYSTEM` is a constant in `@buffr/kernel` (`packages/kernel/src/agents/rag-query-agent.ts`), consumed by buffr's root source as a local npm workspace. buffr's must-not-change constraint is explicit: *"monorepo packages are consumed, not edited at root"* (`context.md`) — the public API surface of `@buffr/kernel` can't change without a build step (`npm run build:packages`). So the canonical system prompt is reviewable and diffable in the same PR as any other change to this repo, one directory over — a real prompt change still requires editing `packages/kernel/src/`, not buffr's root `src/`, and running the package build before it takes effect.

**The profile is the prompt-shaped source buffr DOES own.** Profile rows in `agents.profiles` (read by `loadProfile`, `src/profile.ts:4`) carry `updated_at`, and `loadProfile` takes the most recent. That's a crude version history — you can see *when* the personalization text last changed, though not diff two versions in a PR.

**The routing prompt — new, and owned by buffr.** `session.ts:569-594` now builds an inline routing system prompt that IS directly in buffr's code. It includes: a tool description block listing all active tools (search_knowledge_base, RSS feeds, Amazon reviews, and any web search connectors present) and 7 explicit tool-usage rules:

```
1. ALWAYS call search_knowledge_base first for any question.
2. ALWAYS also call <primaryWebSearch> for any question about: companies,
   people, products, news, current events. (rule conditional: fires only
   if a web search connector is configured)
3. For product reviews, call fetch_amazon_reviews.
4. Synthesize ALL tool results into one answer. Do not stop after just one tool.
5. Cite sources when available.
6. If the knowledge base returns zero relevant results, say so clearly.
7. NEVER fabricate information. Only use what the tools returned.
```

This routing prompt is version-controlled in buffr's own source — a PR diff shows exactly which rules changed. It's the first prompt buffr owns directly in its root `src/` (not one workspace package over, in `@buffr/kernel`). The conditional logic in rule 2 (`primaryWebSearch ? ... : ...`) is code branching on configuration, making the final prompt dynamic based on which API keys are present.

**Observability is real, at the trajectory level.** Every turn persists its full signal through `SupabaseTraceSink` into `agents.messages` — all six `CapabilityEvent` types (step, tool_call_start/end, model_usage, warning, error), with `model` and `tokens_used` populated and `created_at` from the event timestamp for deterministic replay (`context.md`, `src/supabase-trace-sink.ts`).

```js
// run-agent-loop.js:37 — the trace the sink persists
trace?.emit({ type: 'model_usage', provider: model.id,
  model: response.model ?? ..., inputTokens, outputTokens, ... });
```

The boundary condition: you can replay *what happened* on any turn (which tools fired, how many tokens, what the model said) — but you cannot answer "which version of `BASE_SYSTEM` produced this output" from the database, because no prompt-version stamp rides on the `agents.messages` row. That's the missing half — and it's narrower than it used to be. A `PromptRegistry` now exists (`packages/kernel/src/prompt-registry/index.ts`): `session.ts:596-597` registers the routing prompt under `'rag-query-agent/routing'` + `ROUTING_PROMPT_VERSION`, and `RagQueryAgent` exposes the resolved version back as `agent.promptVersion` (`packages/kernel/src/agents/rag-query-agent.ts:38-56`), which `session.ts:682` hands to the UI's `onComplete` callback. So the version is computed and known *in memory, per turn* — it just stops there. It never reaches `supabase-trace-sink.ts` or the `agents.messages` insert, so a SQL query still can't answer "which prompt made this output" after the fact. The gap moved from "doesn't exist" to "exists, not persisted" — a smaller, more specific fix than before.

**The domain packs own a fourth prompt source: prompt-as-data.** `packages/domain-packs/investing/src/prompts.ts` and `packages/domain-packs/market-research/src/prompts.ts` are both a bare `Record<string, string>` keyed identically — `'analyzer-context'` and `'teacher-context'` — version-controlled as ordinary TypeScript files inside their domain-pack package:

```ts
// domain-packs/investing/src/prompts.ts
export const INVESTING_PROMPTS: Record<string, string> = {
  'analyzer-context': 'You are analyzing an investment opportunity. Apply rigorous fundamental analysis. ...',
  'teacher-context': 'Explain the investment analysis to an individual investor. Use plain language. ...',
};
// domain-packs/market-research/src/prompts.ts — same shape, second instance
export const MARKET_RESEARCH_PROMPTS: Record<string, string> = {
  'analyzer-context': 'You are analyzing market demand and consumer pain points from web and social evidence. ...',
  'teacher-context': 'Explain the market research findings to a solo creator building digital products and apps. ...',
};
```

This is the same pattern reused, not a one-off: two domain packs, two identical keys, the same consumption path — `engine.ts:144` (`instructions: [MARKET_RESEARCH_PROMPTS['analyzer-context']]`) and `engine.ts:174` (`instructions: [MARKET_RESEARCH_PROMPTS['teacher-context']]`) inject the string into `Analyzer`/`Teacher`'s `instructions?: string[]` field, which both capabilities append as an `extraInstructions`/`instructionSection` block onto their system or user prompt (`analyzer/index.ts:81-85`, `teacher/index.ts:73-74`). The capability code stays domain-agnostic; the domain pack supplies the tuning. Diffable in a PR like any other TypeScript file, because it is one — no dependency bump required, unlike `BASE_SYSTEM`.

### Move 2.5 — current vs future state

```
  Phase A (now)                       Phase B (the buildable target)
  ─────────────                       ──────────────────────────────
  PromptRegistry computes              prompt-version field written
  agent.promptVersion per turn         onto each agents.messages row
  → reaches the UI onComplete callback → "which prompt made this output?"
  → stops there, never persisted         answerable in a SQL query
```

What doesn't have to change: the trace sink already captures the trajectory, and the version is already being computed per turn — `agent.promptVersion` exists in memory by the time `session.ts:682` builds the `onComplete` payload. Closing the gap is one additive step: thread that same value into the `supabase-trace-sink.ts` write instead of only the UI callback.

### Move 3 — the principle

A prompt is a behavior contract; version it like one. The prompt+model-version pairing is the part that bites: a prompt tuned for Gemma 2 9B is not guaranteed to survive a model swap, and a system that can't tie an output back to the exact (prompt, model) pair that produced it can't debug a regression after the fact.

## Primary diagram

```
  buffr's prompt-as-code — what's versioned, what's observed

  PROMPT SOURCE                             PRODUCTION TRAJECTORY
  ┌─ BASE_SYSTEM (@buffr/kernel) ──────┐   ┌─ agents.messages ──────────┐
  │  reviewed via package source edit   │   │  step · tool_call · usage  │
  ├─ routing prompt (session.ts) ───────┤   │  model · tokens_used       │
  │  7 rules, PR-diffable, code         │──►│  ✗ no prompt_version stamp │
  ├─ profile rows (agents.profiles)  ───┤   └────────────────────────────┘
  │  updated_at = crude history         │        agent.promptVersion IS
  ├─ domain-pack prompts.ts (×2) ───────┤        computed per turn — it
  │  investing + market-research,       │        just never reaches this
  │  identical Record<string,string>    │        row (session.ts:682 stops
  │  shape, PR-diffable, code           │        at the UI callback)
  └──────────────────────────────────────┘
       diffable: routing prompt + domain-pack
       prompts fully in PR history; BASE_SYSTEM
       via package source; profile via DB row
```

## Elaborate

Prompts-as-code is the aipe project's entire thesis (markdown templates as version-controlled prompts, slash commands composing them) — that's the canonical example in this portfolio, and it's where [11-meta-prompting.md](11-meta-prompting.md) picks up. buffr's version is a monorepo split: the core system prompt lives one workspace package over, the domain-pack prompts live directly alongside the code that calls them, and observability is real but not yet stitched to either. The prompt+model-version pairing risk is the one Simon Willison and the eval crowd hammer on — a prompt is only correct *relative to a model*, and model upgrades silently regress eval sets. buffr is one `gemma2:9b` → `gemma3` swap away from needing this.

## Interview defense

**Q: Where do this system's prompts live, and how would you ship a prompt change safely?**

The system prompt (`BASE_SYSTEM`) lives in `@buffr/kernel` (a local workspace package at `packages/kernel/src/agents/rag-query-agent.ts`), so a behavior change ships as a reviewed source edit to that package plus a package build. The routing rules live in `session.ts:569-594` and are version-controlled directly in buffr's source, registered in a `PromptRegistry` under `ROUTING_PROMPT_VERSION`. The domain-pack prompts (`investing/src/prompts.ts`, `market-research/src/prompts.ts`) are diffable TypeScript files, one per domain. The personalization lives in DB rows with `updated_at`. Observability is strong at the trajectory level, and a prompt version is even computed per turn — but that version stops at the UI callback and never ties an output row back to the prompt that made it.

```
  workspace pkg → BASE_SYSTEM → agent.promptVersion computed → output → trace ✓  but: version on the row? ✗
```

Anchor: *"The gap I'd close first is threading `agent.promptVersion` into the `agents.messages` insert — it's already being computed per turn for the UI, so this isn't new plumbing, it's routing an existing value one hop further. Without it you can't debug a regression after a model upgrade by querying the database alone."*

## See also

- [01-anatomy.md](01-anatomy.md) — the prompt sections being versioned
- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — why the prompt+model pairing needs evals to catch regressions
- [11-meta-prompting.md](11-meta-prompting.md) — aipe's prompts-as-code done as the primary thesis
