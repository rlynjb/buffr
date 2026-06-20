# AptKit Organs — Design Spec

**Date:** 2026-06-19
**Status:** Design — approved to capture, implementation not started
**Parent:** refines `agent-layer-plan.md` (buffr root)
**Reader profile:** `aipe/specs/me.md`

---

## What this is

A plan for the **missing parts** — the "organs" — of a Hermes-shaped personal agent,
each specced to fit **aptkit's actual conventions** (verified against the repo, not
assumed). This is deliberately *not* the integrated system. The body — how the organs
assemble into a running agent across laptop + phone — is a separate decision, parked on
purpose (see [Deferred](#deferred--waits-on-the-body-decision)).

The goal: build the parts first, get them real and hand-tested in isolation, *then*
decide the body. This dodges the one-way doors (sync model, gateway, two-brain
topology) while the buildable, decision-independent pieces move now.

### The bigger picture (context, not scope)

The north star is an agent that **lives across your surfaces, owns a model of you, and
acts** — Hermes' *"not a chatbot; an agent that lives on your machine and gets smarter."*
You already have most of its organs scattered across repos:

| Hermes layer            | What already exists                                  |
| ----------------------- | ---------------------------------------------------- |
| persistent memory       | `aipe/specs/me.md` (hand-built model-of-you)         |
| skills framework        | `aipe/` (markdown specs = SKILL.md; slash commands)  |
| model integration       | `aptkit/packages/providers` (anthropic/openai/local/fallback) |
| execution + sub-agents  | Claude Code (terminal, Agent tool, workflows)        |
| RAG / data              | AdvntrCue (shipped) + `agent-layer-plan.md` (specced)|
| trajectory → fine-tune  | named as the ceiling in `agent-layer-plan.md`        |
| **multi-platform gateway** | **❌ nothing**                                     |
| **the spine / body**    | **❌ nothing — organs exist, no body**               |

This spec builds the *aptkit-resident* organs that are still missing or unbuilt. It does
**not** build the body.

### The body decision (deferred — you are thinking about this)

Working architecture reached in brainstorming, recorded so it isn't lost:

```
   LAPTOP                                      PHONE
   ┌─────────────────────────┐                ┌─────────────────────────┐
   │ agent loop (terminal)   │                │ agent loop (RN app)     │
   │ + LOCAL LLM             │                │ + ON-DEVICE LLM         │
   │   Ollama / Gemma2:9b    │                │   Gemini-Nano-class     │
   │   → FULL brain          │                │   → LIGHT brain         │
   └───────────┬─────────────┘                └───────────┬─────────────┘
               │   reasoning is LOCAL on whichever device you're on
               └──────────────────┬──────────────────────────┘
                                  ▼
                  ┌──────────────────────────────────┐
                  │  SUPABASE — shared plane (always on)│
                  │  • memory:  me.md + conversation log │
                  │  • RAG:     chunks + pgvector         │
                  │  • Edge Fn: embed + search            │
                  └──────────────────────────────────┘
```

Reasoning local per device; data + retrieval shared in Supabase. Two open truths to
settle before building the body:

1. **Asymmetric brains.** Laptop Gemma2:9b is already weak at tool-calling; a phone
   on-device model is weaker. The phone can *ask*; the laptop does the *acting*.
2. **Two brains, one memory = a sync/merge problem** — the buffr
   canonical-local-with-cloud-mirror pattern, again. Only bites once both brains are live.

Build order for the body, when chosen: **laptop brain first, phone brain second** — so the
sync problem is the second thing you solve, not the first.

---

## The organs

```
  reasoning          ┌─ @aptkit/provider-gemma ──── the local brain engine
  (brain engine)     │   Ollama → Gemma, implements ModelProvider
                     │   ⚠ THE risk: Gemma has no tool-calling — must emulate
  ───────────────────┤
  the hand           ├─ @aptkit/retrieval ───────── search_knowledge_base tool
  (reach into data)  │   thin HTTP wrapper, ToolDefinition + handler
  ───────────────────┤
  memory seam        ├─ @aptkit/context/profile-injector.ts
  (makes it YOURS)   │   load me.md → inject into system prompt
  ───────────────────┤
  the ruler          ├─ @aptkit/evals/precision-at-k.ts
  (the numbers)      │   the metric aptkit is missing
  ───────────────────┘
  capstone           └─ profile-aware RAG agent — wires the four above,
  (proves compose)       terminal-only, no Supabase/phone/sync yet
```

All aptkit packages follow the same shape (verified): `@aptkit/<name>`, `"type":
"module"`, `tsc` build, tests via `node --test dist/test/*.test.js` using `node:test` +
`node:assert/strict`, `tsconfig` extends `../../../tsconfig.base.json` and references
`../../runtime`.

---

### A — `@aptkit/provider-gemma` · the local brain engine

**Path:** `packages/providers/gemma/`
**Implements:** `ModelProvider` from `packages/runtime/src/model-provider.ts`:

```ts
type ModelProvider = {
  id: string;
  defaultModel?: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
};
```

`complete()` maps aptkit's `ModelMessage[]` / `ModelTool[]` to the Ollama `/api/chat`
wire format and maps the response back to `ModelContentBlock[]` (`text` and `tool_use`
blocks) + `usage`. Wrap the instance in the `ContextWindowGuardedProvider` pattern from
`packages/providers/local/src/context-window-guard.ts` (Gemma2:9b ≈ 8k window). Register
by explicit instantiation (there is no global registry); composes under
`@aptkit/provider-fallback` for an API fallback chain.

**⚠ The hard part — the whole reason this organ is risky.**
The runtime expects the provider to surface `tool_use` blocks so `run-agent-loop` can
dispatch tools. **Gemma2:9b emits none** — Ollama has no tool template for it. So the
provider must:

1. **Outbound:** render available tools into the prompt/system text (Gemma can't take a
   native `tools` array meaningfully).
2. **Inbound:** prompt Gemma to print any tool call as JSON, then **parse that text back
   into `ModelToolUseBlock`** using `parseAgentJson` from
   `packages/runtime/src/structured-generation.ts` (already strips ``` fences and
   scavenges the first balanced `{…}`/`[…]` out of messy output).

Outbound is trivial; **inbound text→`tool_use` is the engineering**, and it's where the
agent loop stalls if it's flaky. This is the riskiest piece in the project — `de-risk
first` from the parent plan points exactly here. Try Ollama-native tool support first in
case a model template lands; assume emulation is required for Gemma2.

**Separation of concerns:** the provider only returns raw text + parsed blocks. It does
**not** validate JSON schemas — `generateStructured` (runtime) owns retry-with-strict-suffix.

**Hand-test artifact:** `node --test` over a recorded Ollama response fixture — assert a
deliberately messy Gemma blob parses into a clean `tool_use` block, and that plain text
returns a single `text` block. No live Ollama needed for the unit test.

**Depends on:** `@aptkit/runtime` only. **Long pole — build first, alone.**

---

### B — `@aptkit/retrieval` · the hand

**Path:** `packages/retrieval/`
**Implements:** the tool contracts from `packages/tools/src/tool-registry.ts`:

```ts
type ToolDefinition = { name: string; description?: string; inputSchema: object };
type ToolHandler = (args: Record<string, unknown>, opts?: ToolCallOptions) => Promise<unknown> | unknown;
```

Exports `searchKnowledgeBaseDefinition` (`name: 'search_knowledge_base'`) and a
`createSearchKnowledgeBaseTool({ endpoint, apiKey? }) → ToolHandler` factory. The handler
is a thin `fetch` to a vector-search endpoint returning ranked chunks. Honors
`opts.signal`. Wired into agents via `filterToolsForPolicy(allTools, policy)`.

**Build without Supabase.** Point the handler at a mock endpoint; test through
`InMemoryToolRegistry([def], { search_knowledge_base: handler })`. The real endpoint is
service-layer and deferred.

**Hand-test artifact:** registry test — mock returns ranked docs; assert the tool
definition shape and that `callTool` returns the ranked result with a `durationMs`.

**Depends on:** `@aptkit/runtime`, `@aptkit/tools`. Independent of A — parallel.

---

### C — `@aptkit/context/profile-injector.ts` · the memory seam

**Path:** new file in `packages/context/` (today the package only does workspace schema
summaries via `schemaSummary` — no profile primitive exists).

**Interface — keep it pure:**

```ts
function injectProfile(systemTemplate: string, profileText: string, opts?: { position?: 'start' | 'end'; heading?: string }): string;
```

Prepends (default) the `me.md` text into the system prompt *before*
`renderPromptTemplate` (from `@aptkit/prompts`) runs. **Correction to the earlier sketch:**
the function takes the profile *string*, not a file path — the caller reads the file. Pure
function, no `fs` inside the package: easier to test, matches aptkit's pure-function
style, and ESM-safe (no `require`).

This is the organ that turns "a RAG box" into "*your* assistant" — it's where `me.md`
becomes live system context instead of a doc only `aipe` reads.

**Hand-test artifact:** unit test — given a template with `{schema}` and a fake `me.md`,
assert the profile text lands in the assembled system string at the right position and
template rendering still works.

**Depends on:** nothing (string in, string out). Independent — parallel.

---

### D — `@aptkit/evals/precision-at-k.ts` · the ruler

**Path:** new file in `packages/evals/`.
**Confirmed missing:** grep for `precision|recall|retrieval|ndcg|mrr` over
`packages/evals/src` returns nothing. The parent plan's *"run AptKit's eval-harness:
precision@5"* is aspirational — **no eval-harness exists** (only `rubric-judge`,
`detection-scorer`, structural assertions, and a replay-*artifact* validator). The
`detection-scorer` matches categorical field values, not ranked relevance — not reusable
for precision@k.

**Interface** (match the `DetectionScoreResult` shape for consistency):

```ts
function scorePrecisionAtK(retrievedIds: readonly string[], relevantIds: ReadonlySet<string>, k: number): { ok: boolean; score: number; matched: number; total: number };
```

Pure function. Smallest organ, highest portfolio leverage — it's the "numbers" the
parent plan's thesis sells. Add a sibling `scoreRecallAtK` for free.

**Faithfulness comes free** from the existing `RubricJudge`
(`packages/evals/src/rubric-judge.ts`) — define a rubric with grounding /
no-hallucination dimensions and **inject Claude as the judge model**, not Gemma. Don't
let Gemma grade Gemma; that number would be circular.

**Hand-test artifact:** unit test — known ranking + known relevant set → known
precision@k value; edge cases (k > list length, no relevant docs).

**Depends on:** nothing. Independent — parallel.

---

### E — capstone: profile-aware RAG agent · proves the organs compose

**Path:** mirror `packages/agents/query/` (new agent package, e.g.
`packages/agents/rag-query/`).

Wires the four organs through `runAgentLoop`:

- **A** Gemma provider (guarded) as `model`
- **B** retrieval tool registered, surfaced via `filterToolsForPolicy`
- **C** `me.md` injected into the system prompt before `renderPromptTemplate`
- **D** used in its eval to measure retrieval quality + faithfulness

Runs in the **terminal, one shot, against a mock retrieval endpoint**. No Supabase, no
phone, no sync, no gateway. This is the smallest *living* thing — and it is exactly the
deferred body's **v1a (laptop brain)**, reachable later without rework.

**Hand-test artifact:** ask it a question; observe it emit a `tool_use` for
`search_knowledge_base`, receive mock chunks, and answer grounded + in your voice
(profile visibly shaping tone). An eval run reports precision@k and a faithfulness score.

**Depends on:** A, B, C (and D for its eval). Build last.

---

## Build order

```
  A  provider-gemma   ████████████  long pole — start now, riskiest
  B  retrieval        ███           ┐
  C  profile-injector ██            ├ independent, parallel, easy wins
  D  precision-at-k   ██            ┘
                          ↓ once A done + B,C present
  E  capstone agent       ████      wires A+B+C, measured by D
```

De-risk first: A alone proves tool-call emulation works at all; everything downstream
assumes it. B/C/D are afternoon-sized and parallel. E is the payoff and yields a living
laptop-only brain with every body decision still open.

Each organ is built test-first (`node:test`) and ends in a hand-testable artifact, per
the parent plan's "each phase ends in a hand-testable artifact" discipline.

---

## Deferred — waits on the body decision

Not in this spec; depends on the architecture you're thinking through:

- Supabase `agents` schema (documents / chunks / conversations / messages / tool_runs), pgvector + HNSW, RLS
- Edge Functions (embed + vector search + the always-on data plane)
- The embedding pipeline (`nomic-embed-text`, 768-dim — a one-way door per the parent plan)
- The phone RN brain (on-device model) and its agent loop
- Memory **sync/merge** between laptop and phone (the buffr local-first pattern)
- The multi-platform **gateway** (terminal + Telegram, "start on one, continue on another")
- Trajectory capture → fine-tune (the ceiling)

---

## Corrections this spec makes to `agent-layer-plan.md`

1. **No `eval-harness` / precision@k exists in aptkit.** They are net-new (organ D). The
   parent plan treats them as turnkey; they are not. `rubric-judge` (faithfulness) is real.
2. **Gemma2:9b has no native tool-calling.** Organ A's core work is emulation + parsing,
   not just "tame the JSON." The parent plan's Phase-1 risk line conflates structured
   *output* with tool-call *decoding* — they are different failure surfaces.
3. **Judge with Claude, not Gemma.** Faithfulness scored by the same model being graded
   is circular. `providers/anthropic` already exists for this.
4. **Model is a provider, not a pinned choice.** "Self-hosted" = data/memory/skills are
   yours; the model is swappable (`aptkit/packages/providers` is why). Keeps the Gemma
   thesis while letting an API model do reliable *acting* when needed.
